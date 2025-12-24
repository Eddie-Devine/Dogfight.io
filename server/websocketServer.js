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
const CHAT_HISTORY_LIMIT = 50;
const CHAT_MAX_LENGTH = 280;
const CHAT_COLORS = [
	'#7DF5C3',
	'#69B7DD',
	'#B0A7FF',
	'#F2A77E',
	'#F0E989',
	'#FFB7D5',
	'#9BCF53',
	'#E26D5A',
	'#A2F2B4',
	'#C5A3FF',
	'#FFDE85',
];
const MAX_DAMAGE_PER_HIT = 250;
const CANNON_MUZZLE_SPEED = 600;         // world units per second
const CANNON_PROJECTILE_TTL = 2500;      // ms
const players = new Map();
const chatHistory = [];

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

function broadcast(payload, excludeWs = null) {
	const data = JSON.stringify(payload);
	for (const p of players.values()) {
		const targetWs = p.ws;
		if (!targetWs || targetWs.readyState !== targetWs.OPEN) continue;
		if (excludeWs && targetWs === excludeWs) continue;
		try {
			targetWs.send(data);
		} catch {
			// ignore failed send
		}
	}
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
		cannon: {
			ammo: playerState.cannonAmmo,
			rate: playerState.cannonRate,
			cooldownMs: playerState.cannonCooldownMs,
			burstMs: playerState.cannonBurstMs,
		},
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
					health: target.health,
					maxHealth: target.maxHealth,
				});
				visibleIds.add(id);
			}
		}

	observer.lastRadarContacts = contacts;
	observer.visibleTargets = visibleIds;
	return contacts;
}

function initCannonState(state, mechanics, num) {
	const rate = Math.max(1, num(mechanics.cannonRate, 0));
	const cooldownMs = Math.max(0, num(mechanics.cannonCooldown, 0));
	const burstMs = Math.max(0, num(mechanics.cannonBurst, 0));
	const ammo = Math.max(0, num(mechanics.cannonAmmo, 0));
	Object.assign(state, {
		cannonRate: rate,
		cannonCooldownMs: cooldownMs,
		cannonBurstMs: burstMs,
		cannonAmmo: ammo,
		cannonLastFire: 0,
		cannonBurstUsed: 0,
		cannonCooldownUntil: 0,
		cannonPendingShots: 0,
	});
}

function handleCannonFire(state) {
	const now = Date.now();
	if (state.cannonLastFire && (now - state.cannonLastFire) > state.cannonCooldownMs) {
		state.cannonBurstUsed = 0;
	}

	if (state.cannonCooldownMs > 0 && state.cannonCooldownUntil && now < state.cannonCooldownUntil) {
		return {
			allowed: false,
			reason: 'cooldown',
			cooldownRemaining: Math.max(0, state.cannonCooldownUntil - now),
		};
	}

	if (state.cannonAmmo <= 0) {
		return { allowed: false, reason: 'ammo', ammo: 0 };
	}

	if (state.cannonRate <= 0) {
		return { allowed: false, reason: 'rate' };
	}

	const rateMs = 1000 / Math.max(1, state.cannonRate);
	if (state.cannonLastFire && (now - state.cannonLastFire) < rateMs) {
		return {
			allowed: false,
			reason: 'rate',
			wait: Math.max(0, rateMs - (now - state.cannonLastFire)),
		};
	}

	const burstLimit = Math.max(0, state.cannonBurstMs);
	const newBurstUsed = state.cannonBurstUsed + rateMs;
	if (burstLimit > 0 && newBurstUsed > burstLimit) {
		state.cannonCooldownUntil = state.cannonCooldownMs > 0 ? now + state.cannonCooldownMs : 0;
		state.cannonBurstUsed = 0;
		return {
			allowed: false,
			reason: 'cooldown',
			cooldownRemaining: Math.max(0, state.cannonCooldownUntil - now),
		};
	}

	state.cannonAmmo = Math.max(0, state.cannonAmmo - 1);
	state.cannonLastFire = now;
	state.cannonBurstUsed = newBurstUsed;
	state.cannonPendingShots = Math.max(0, (state.cannonPendingShots || 0)) + 1;

	const heading = state.heading || 0;
	const dirX = Math.sin(heading);
	const dirY = -Math.cos(heading);
	const speed = Math.max(0, CANNON_MUZZLE_SPEED + (state.speed || 0));
	const vel = { x: dirX * speed, y: dirY * speed };

	if (burstLimit > 0 && state.cannonBurstUsed >= burstLimit) {
		state.cannonCooldownUntil = state.cannonCooldownMs > 0 ? now + state.cannonCooldownMs : 0;
		state.cannonBurstUsed = 0;
	}

	return {
		allowed: true,
		ammo: state.cannonAmmo,
		burstRemaining: Math.max(0, burstLimit - state.cannonBurstUsed),
		cooldownRemaining: Math.max(0, state.cannonCooldownUntil - now),
		projectile: {
			weapon: 'cannon',
			shooterId: state.id,
			pos: { x: state.pos.x, y: state.pos.y },
			vel,
			ttlMs: CANNON_PROJECTILE_TTL,
			at: now,
		},
	};
}

function applyDamage(attackerId, targetId, amount, meta = {}) {
	const target = players.get(targetId);
	if (!target) return null;
	if (!Number.isFinite(amount) || amount <= 0) return null;
	if (target.health <= 0) return null;

	const damage = Math.min(MAX_DAMAGE_PER_HIT, Math.max(0, amount));
	const previousHealth = target.health;
	target.health = Math.max(0, target.health - damage);

	const hitEvent = {
		type: 'combat:damage',
		attackerId,
		targetId,
		amount: damage,
		remainingHealth: target.health,
		at: Date.now(),
	};
	if (meta.weapon) hitEvent.weapon = meta.weapon;
	if (meta.pos && typeof meta.pos.x === 'number' && typeof meta.pos.y === 'number') {
		hitEvent.pos = { x: clampCoord(meta.pos.x), y: clampCoord(meta.pos.y) };
	}

	broadcast(hitEvent);

	if (target.health <= 0 && previousHealth > 0) {
		const deathEvent = {
			type: 'combat:death',
			attackerId,
			targetId,
			at: Date.now(),
			pos: { x: target.pos.x, y: target.pos.y },
		};
		if (meta.weapon) deathEvent.weapon = meta.weapon;
		broadcast(deathEvent);
	}

	return {
		damageApplied: damage,
		remainingHealth: target.health,
	};
}

function createWebSocketServer(options = {}) {
	const wsPath = options.path || process.env.WS_PATH || '/ws/';
	const port = Number(options.port || process.env.WS_PORT || 3001);
	const server = http.createServer();

	const pickChatColor = () => {
		const used = new Set();
		for (const p of players.values()) {
			if (p.chatColor) used.add(p.chatColor);
		}
		for (const color of CHAT_COLORS) {
			if (!used.has(color)) return color;
		}
		// If all are taken, fall back to a deterministic choice to keep things stable.
		return CHAT_COLORS[players.size % CHAT_COLORS.length];
	};

	const wss = new WebSocketServer({ server, path: wsPath });
	wss.players = players;
	const syncTimer = setInterval(() => {
		for (const state of players.values()) {
			if (!state?.ws || state.ws.readyState !== state.ws.OPEN) continue;
			const radarContacts = collectRadarContacts(state);

			const threatIds = getThreatIds(state.id);
			const trackedBy = threatIds.length > 0;
			const now = Date.now();
			const ammo = Number.isFinite(state.cannonAmmo) ? state.cannonAmmo : 0;
			const cooldownRemaining = Math.max(0, (state.cannonCooldownUntil || 0) - now);

			try {
				state.ws.send(JSON.stringify({
					type: 'state:sync',
					fuel: state.fuel,
					health: state.health,
					radar: radarContacts,
					rwr: { detected: trackedBy, targets: threatIds },
					cannon: {
						ammo,
						cooldownRemaining,
					},
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
	state.chatColor = pickChatColor();
	initCannonState(state, mechanics, num);

		players.set(playerId, state);

				ws.send(JSON.stringify({
					type: 'session:init',
					player: sanitizePlayerState(state),
					chatColor: state.chatColor,
					jet,
				}));

				if (chatHistory.length > 0) {
					ws.send(JSON.stringify({ type: 'chat:history', messages: chatHistory }));
				}

			const joinMessage = {
				type: 'chat:message',
				from: { id: 'server', name: 'Server', jetId: null, color: '#9FE3FF' },
				text: `${state.name || 'Player'} joined the fight`,
				at: Date.now(),
			};
			chatHistory.push(joinMessage);
			if (chatHistory.length > CHAT_HISTORY_LIMIT) {
				chatHistory.shift();
			}
			for (const playerState of players.values()) {
				const targetWs = playerState.ws;
				if (!targetWs || targetWs.readyState !== targetWs.OPEN) continue;
				try {
					targetWs.send(JSON.stringify(joinMessage));
				} catch {
					// ignore send failure
				}
			}

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
					state.speed = reportedSpeed;
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
							rwr: { detected: trackedBy, targets: threatIds },
						}));
					} catch {
						// ignore send failure
					}
					} else if (msg?.type === 'combat:damage') {
						const targetId = typeof msg.targetId === 'string' ? msg.targetId : null;
						const amount = Number(msg.amount);
						if (!targetId || targetId === state.id) return;

						const weapon = typeof msg.weapon === 'string' ? msg.weapon : undefined;
						const pos = (msg.pos && typeof msg.pos.x === 'number' && typeof msg.pos.y === 'number')
							? { x: msg.pos.x, y: msg.pos.y }
							: undefined;

						if (weapon === 'cannon') {
							if (!state.cannonPendingShots || state.cannonPendingShots <= 0) return;
							state.cannonPendingShots -= 1;
						}

						applyDamage(state.id, targetId, amount, { weapon, pos });
					} else if (msg?.type === 'combat:fire') {
						const weapon = typeof msg.weapon === 'string' ? msg.weapon : null;
						if (weapon !== 'cannon') return;
						const result = handleCannonFire(state);
						try {
							ws.send(JSON.stringify({
								type: 'combat:fire:ack',
								weapon: 'cannon',
								allowed: result.allowed,
								ammo: state.cannonAmmo,
								cooldownRemaining: result.cooldownRemaining || 0,
								burstRemaining: result.burstRemaining ?? null,
								reason: result.allowed ? undefined : result.reason,
							}));
						} catch {
							// ignore
						}
						if (result.allowed && result.projectile) {
							const payload = {
								type: 'combat:projectile',
								weapon: 'cannon',
								shooterId: state.id,
								pos: result.projectile.pos,
								vel: result.projectile.vel,
								ttlMs: result.projectile.ttlMs,
								at: result.projectile.at,
							};
							broadcast(payload, ws);
						}
					} else if (msg?.type === 'chat:send' && typeof msg.text === 'string') {
						const text = msg.text.trim().slice(0, CHAT_MAX_LENGTH);
						if (text.length === 0) return;

						const entry = {
						type: 'chat:message',
						from: { id: state.id, name: state.name, jetId: state.jetId, color: state.chatColor },
						text,
						at: Date.now(),
					};

					chatHistory.push(entry);
					if (chatHistory.length > CHAT_HISTORY_LIMIT) {
						chatHistory.shift();
					}

					for (const playerState of players.values()) {
						const targetWs = playerState.ws;
						if (!targetWs || targetWs.readyState !== targetWs.OPEN) continue;
						try {
							targetWs.send(JSON.stringify(entry));
						} catch {
							// ignore send failure
						}
					}
				}
			});

			ws.on('close', () => {
				const tracked = players.get(playerId);
				if (tracked && tracked.ws === ws) {
					const leaveMessage = {
						type: 'chat:message',
						from: { id: 'server', name: 'Server', jetId: null, color: '#9FE3FF' },
						text: `${tracked.name || 'Player'} left the fight`,
						at: Date.now(),
					};
					chatHistory.push(leaveMessage);
					if (chatHistory.length > CHAT_HISTORY_LIMIT) {
						chatHistory.shift();
					}
					for (const playerState of players.values()) {
						const targetWs = playerState.ws;
						if (!targetWs || targetWs.readyState !== targetWs.OPEN) continue;
						try {
							targetWs.send(JSON.stringify(leaveMessage));
						} catch {
							// ignore send failure
						}
					}
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
