const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');

const {
	JETS_BY_ID,
	SESSION_COOKIE,
	JWT_SECRET,
} = require('./httpServer');

const COORD_LIMIT = 1e6;
const RADAR_PUSH_INTERVAL = 1000 / 30;
const STATE_SYNC_INTERVAL = 100;
const players = new Map();

function parseCookies(header = '') {
	return header.split(';').reduce((acc, pair) => {
		const [key, value] = pair.split('=');
		if (!key) return acc;
		acc[key.trim()] = decodeURIComponent((value || '').trim());
		return acc;
	}, {});
}

function clampCoord(value) {
	if (!Number.isFinite(value)) return 0;
	return Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, value));
}

function getThreatIds(targetId) {
	const ids = [];
	const target = players.get(targetId);
	if (!target) return ids;
	const maxDistSq = (Number(target.rwrDistance) || 0) ** 2;
	for (const observer of players.values()) {
		if (observer.id === targetId) continue;
		if (!observer.visibleTargets || !observer.visibleTargets.has(targetId)) continue;
		if (maxDistSq > 0) {
			const dx = observer.pos.x - target.pos.x;
			const dy = observer.pos.y - target.pos.y;
			const distSq = dx * dx + dy * dy;
			if (distSq > maxDistSq) continue;
		}
		ids.push(observer.id);
	}
	return ids;
}

function sanitizePlayerState(playerState) {
	return {
		id: playerState.id,
		name: playerState.name,
		jetId: playerState.jetId,
		pos: { ...playerState.pos },
		heading: playerState.heading || 0,
		health: playerState.health,
		maxHealth: playerState.maxHealth,
		fuel: playerState.fuel,
		maxFuel: playerState.maxFuel,
		radar: playerState.lastRadarContacts || [],
	};
}

function applyFuelBurn(state, reportedSpeed = 0) {
	const now = Date.now();
	const dt = Math.max(0, now - (state.lastFuelTick || now));
	state.lastFuelTick = now;

	const rateMs = Math.max(50, Number(state.fuelRate) || 1000);
	const referenceSpeed = Math.max(1, Number(state.maxSpeed) || 1);
	const speedFactor = Math.max(0, reportedSpeed / referenceSpeed);
	const burnUnits = (dt / rateMs) * speedFactor;

	if (burnUnits > 0) {
		state.fuel = Math.max(0, state.fuel - burnUnits);
	}
}

function collectRadarContacts(observer, snapshots = false) {
	const now = Date.now();
	if ((observer.nextRadarPush || 0) > now) return observer.lastRadarContacts || [];
	observer.nextRadarPush = now + RADAR_PUSH_INTERVAL;

	const range = Number(observer.radarDistance) || 0;
	if (range <= 0) {
		observer.lastRadarContacts = [];
		return observer.lastRadarContacts;
	}

	const rangeSq = range * range;
	const visibleIds = new Set();
	const contacts = [];

	for (const [id, target] of players) {
		if (id === observer.id) continue;
		const dx = target.pos.x - observer.pos.x;
		const dy = target.pos.y - observer.pos.y;
		const distSq = dx * dx + dy * dy;
		if (distSq <= rangeSq) {
			contacts.push({
				id: target.id,
				name: target.name,
				pos: { x: target.pos.x, y: target.pos.y },
				heading: target.heading || 0,
			});
			visibleIds.add(id);
		}
	}

	observer.lastRadarContacts = contacts;
	observer.visibleTargets = visibleIds;
	return contacts;
}

function createWebSocketServer(options = {}) {
	const wsPath = options.path || process.env.WS_PATH || '/ws/';
	const port = Number(options.port || process.env.WS_PORT || 3001);
	const server = http.createServer();

	const wss = new WebSocketServer({ server, path: wsPath });
	wss.players = players;
	const syncTimer = setInterval(() => {
		for (const state of players.values()) {
			if (!state?.ws || state.ws.readyState !== state.ws.OPEN) continue;
			const radarContacts = collectRadarContacts(state);

			const threatIds = getThreatIds(state.id);
			const trackedBy = threatIds.length > 0;

			try {
				state.ws.send(JSON.stringify({
					type: 'state:sync',
					fuel: state.fuel,
					health: state.health,
					radar: radarContacts,
					rwr: { search: trackedBy, targets: threatIds },
				}));
			} catch {
				// ignore
			}
		}
	}, STATE_SYNC_INTERVAL);
	server.on('close', () => clearInterval(syncTimer));

		wss.on('connection', (ws, req) => {
			const cookies = parseCookies(req?.headers?.cookie || '');
		const token = cookies[SESSION_COOKIE];

		if (!token) {
			ws.close(4401, 'Missing session');
			return;
		}

		let payload;
		try {
			payload = jwt.verify(token, JWT_SECRET);
		} catch {
			ws.close(4401, 'Invalid session');
			return;
		}

		const jet = payload?.jet ? JETS_BY_ID.get(payload.jet) : null;
		if (!jet) {
			ws.close(4404, 'Jet not found');
			return;
		}

			const playerId = `${payload.name || 'anon'}:${payload.jet}`;
			const mechanics = jet?.Mechanics || {};
			const num = (val, fallback = 0) => {
				const n = Number(val);
				return Number.isFinite(n) ? n : fallback;
			};

	const maxHealth = num(mechanics.maxHealth, 100);
	const maxFuel = num(mechanics.maxFuel, 100);
	const fuelRate = num(mechanics.fuelRate, 1000);
	const maxSpeed = num(mechanics.maxSpeed, 1);
	const radarDistance = num(mechanics.radarDistance, 0);
	const rwrDistance = num(mechanics.RWRDistance ?? mechanics.rwrDistance, radarDistance);

			if (players.has(playerId)) {
				const existing = players.get(playerId);
			if (existing.ws && existing.ws !== ws) {
				existing.ws.close(4001, 'Session superseded');
			}
		}

		const state = {
			id: playerId,
			name: payload.name,
			jetId: payload.jet,
			pos: { x: 0, y: 0 },
			health: maxHealth,
			maxHealth,
			fuel: maxFuel,
			maxFuel,
		fuelRate,
		maxSpeed,
		radarDistance,
		rwrDistance,
		heading: 0,
		ws,
		lastUpdate: Date.now(),
			lastFuelTick: Date.now(),
			nextRadarPush: Date.now(),
		};

			players.set(playerId, state);

			ws.send(JSON.stringify({
				type: 'session:init',
				player: sanitizePlayerState(state),
				jet,
			}));

			ws.on('message', (data) => {
				if (!data) return;
				let msg;
				try {
					msg = JSON.parse(data.toString());
			} catch {
				return;
			}

				if (msg?.type === 'state:update') {
					const reportedSpeed = typeof msg.speed === 'number' ? Math.max(0, msg.speed) : 0;
					if (typeof msg.pos?.x === 'number') state.pos.x = clampCoord(msg.pos.x);
					if (typeof msg.pos?.y === 'number') state.pos.y = clampCoord(msg.pos.y);
					if (typeof msg.heading === 'number') state.heading = Number(msg.heading);
					if (typeof msg.health === 'number') {
						state.health = Math.max(0, Math.min(state.maxHealth, msg.health));
					}
					applyFuelBurn(state, reportedSpeed);
					state.lastUpdate = Date.now();

					try {
						const radarContacts = collectRadarContacts(state);

						const threatIds = getThreatIds(state.id);
						const trackedBy = threatIds.length > 0;

						ws.send(JSON.stringify({
							type: 'state:sync',
							fuel: state.fuel,
							health: state.health,
							radar: radarContacts,
							rwr: { search: trackedBy, targets: threatIds },
						}));
					} catch {
						// ignore send failure
					}
				}
			});

		ws.on('close', () => {
			const tracked = players.get(playerId);
			if (tracked && tracked.ws === ws) {
				players.delete(playerId);
			}
		});
	});

	server.listen(port, () => {
		const address = server.address();
		const host = address?.address && address.address !== '::' ? address.address : 'localhost';
		const portInfo = address?.port ? `:${address.port}` : '';
		console.log(`WebSocket server listening on ws://${host}${portInfo}${wsPath}`);
	});

	return { server, wss };
}

	module.exports = { createWebSocketServer };
