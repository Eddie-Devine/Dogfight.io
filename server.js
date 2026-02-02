const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const JWT = require('jsonwebtoken');
const crypto = require('crypto');

const PORT = 3000;
const JWT_SECRET = 'DEV_ONLY_CHANGE_ME';

const VALID_GAMEMODES = ['freeforall'];
const FREE_JETS = ['F22', 'A10'];
const DEFAULT_CALLSIGNS = [
	'Maverick', 'Iceman', 'Goose', 'Viper', 'Jester',
	'Cougar', 'Merlin', 'Sundown', 'Chipper', 'Hollywood'
];
const JET_CONFIG = {
	'F22': {
		scale: 10,
		maxBankAngle: 90,
		maxTurnRate: 100, // degrees per second at optimal speed
		optimalTurnSpeed: 250, // speed where turning is best
		minSpeed: 100,
		maxSpeed: 500,
	},
	'A10': {
		scale: 10,
		maxBankAngle: 60,
		maxTurnRate: 60,
		optimalTurnSpeed: 250,
		minSpeed: 80,
		maxSpeed: 400,
	}
};

const room = {
	freeforall: new Map()
}

const app = express();
expressWs(app);

function getRandomItem(array) {
	return array[Math.floor(Math.random() * array.length)];
}

function sanitizeCallsign(callsign) {
	if (!callsign || typeof callsign !== 'string') {
		return null;
	}

	// Remove special characters, keep only alphanumeric, spaces, dashes, underscores
	let sanitized = callsign.replace(/[^a-zA-Z0-9\s\-_]/g, '');

	// Trim whitespace
	sanitized = sanitized.trim();

	// Limit length
	sanitized = sanitized.substring(0, 20);

	// Must have at least 1 character after sanitization
	return sanitized.length > 0 ? sanitized : null;
}

function angleDifference(target, current) {
	let diff = target - current;
	while (diff > 180) diff -= 360;
	while (diff < -180) diff += 360;
	return diff;
}

function calculateTurnRate(speed, config) {
	const { maxTurnRate, optimalTurnSpeed, minSpeed, maxSpeed } = config;
	const speedDiff = Math.abs(speed - optimalTurnSpeed);
	const maxDiff = Math.max(optimalTurnSpeed - minSpeed, maxSpeed - optimalTurnSpeed);
	const efficiency = 1 - (speedDiff / maxDiff) * 0.6;
	return maxTurnRate * efficiency;
}

function updatePlayerPhysics(player, deltaTime) {
	const config = JET_CONFIG[player.jet];

	// Calculate angle to mouse cursor
	const dx = player.mousePos.worldX - player.pos.x;
	const dz = player.mousePos.worldZ - player.pos.z;
	const targetHeading = Math.atan2(dx, dz) * (180 / Math.PI);

	// Calculate turn
	const headingDiff = angleDifference(targetHeading, player.heading);
	const currentTurnRate = calculateTurnRate(player.speed, config);
	const turnAmount = Math.sign(headingDiff) * Math.min(Math.abs(headingDiff), currentTurnRate * deltaTime);

	player.heading += turnAmount;

	// Normalize heading
	while (player.heading >= 360) player.heading -= 360;
	while (player.heading < 0) player.heading += 360;

	// Update position
	const headingRad = player.heading * (Math.PI / 180);
	const velocityX = Math.sin(headingRad) * player.speed * deltaTime;
	const velocityZ = Math.cos(headingRad) * player.speed * deltaTime;

	player.pos.x += velocityX;
	player.pos.z += velocityZ;

	// Calculate bank angle
	const targetBankAngle = (turnAmount / (currentTurnRate * deltaTime)) * config.maxBankAngle;
	const bankSmoothness = 5;
	player.bankAngle += (targetBankAngle - player.bankAngle) * Math.min(deltaTime * bankSmoothness, 1);
}

app.ws('/game/freeforall', (ws, req) => {
	const token = req.query.token; //token user is given to join the game

	//missing token handler
	if (!token) {
		ws.close(4401, 'Missing token');
		return;
	}

	let playerData;
	try {
		playerData = JWT.verify(token, JWT_SECRET);
	} catch (err) {
		ws.close(4401, 'Invalid token');
		return;
	}

	// Server keeps these constants
	const WORLD_SIZE = 30000;
	const players = room.freeforall;

	let playerID; // or crypto.randomBytes(16).toString('hex')
	do {
		playerID = crypto.randomUUID();
	} while (players.has(playerID));

	players.set(playerID, {
		connection: ws,
		ready: false,
		callsign: playerData.callsign,
		jet: playerData.jet,
		pos: {
			x: 0,
			z: 0
		},
		mousePos: {
			worldX: 0,
			worldZ: 0
		},
		speed: 100,
		heading: 0,
		bankAngle: 0,
		lastUpdate: Date.now()
	});

	const player = players.get(playerID);

	ws.send(JSON.stringify({
		type: 'session:init',
		callsign: playerData.callsign,
		gamemode: playerData.gamemode,
		jet: playerData.jet,
		pos: {
			x: 0,
			z: 0
		},
		worldSize: WORLD_SIZE,
	}));

	ws.on('message', (message) => {
		let data;

		try {
			data = JSON.parse(message);

		} catch (error) {
			console.error('Error parsing message:', error);
			return;
		}

		if (data.type === 'session:ready') {
			console.log('player connected');
			player.ready = true;
			player.lastUpdate = Date.now();

			player.connection.send(JSON.stringify({
				type: 'position:update',
				pos: { x: player.pos.x, z: player.pos.z },
				heading: player.heading,
				bankAngle: player.bankAngle
			}));
		}

		if (data.type === 'mouse:update') {
			player.mousePos.worldX = data.mouse.worldX;
			player.mousePos.worldZ = data.mouse.worldZ;
		}
	});

	ws.on('close', () => {
		players.delete(playerID);
		console.log('player disconnected');
	});
});

app.use(express.static(path.join(__dirname, 'Public'), { etag: false, lastModified: false }));
app.use(express.json());

//middlewear to block invalid json
app.use((err, req, res, next) => {
	if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
		return res.status(400).json({ error: 'Invalid JSON body' });
	}
	next(err);
});

// Disable HTTP caching for all responses
app.use((req, res, next) => {
	res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
	res.setHeader('Pragma', 'no-cache');
	res.setHeader('Expires', '0');
	res.setHeader('Surrogate-Control', 'no-store');
	next();
});

//verify/santize guest info
//gives token client uses to join websocket connection to game
app.post('/init/guest', (req, res) => {
	const { callsign, jet, gamemode } = req.body;

	// Validate and assign callsign
	let validatedCallsign = sanitizeCallsign(callsign);
	if (!validatedCallsign) {
		validatedCallsign = getRandomItem(DEFAULT_CALLSIGNS);
	}

	// Validate and assign gamemode
	let validatedGamemode = gamemode;
	if (!validatedGamemode || !VALID_GAMEMODES.includes(validatedGamemode)) {
		validatedGamemode = getRandomItem(VALID_GAMEMODES);
	}

	// Validate and assign jet
	let validatedJet = jet;
	if (!validatedJet || !FREE_JETS.includes(validatedJet)) {
		validatedJet = getRandomItem(FREE_JETS);
	}

	// Create token with validated data
	const token = JWT.sign(
		{
			callsign: validatedCallsign,
			jet: validatedJet,
			gamemode: validatedGamemode
		},
		JWT_SECRET,
		{ expiresIn: '1h' }
	);

	res.json({ token, gamemode });
});

//404 just sends users to main menu
app.get('*', (req, res) => {
	res.redirect('/');
});

app.listen(PORT, () => {
	console.log(`Server on port ${PORT}`);
});

setInterval(() => {
	const players = room.freeforall;
	const now = Date.now();

	players.forEach(player => {
		if (!player.ready) return;

		console.log(player)

		// Calculate delta time
		const deltaTime = (now - player.lastUpdate) / 1000;
		player.lastUpdate = now;

		console.log('hey');

		// Update physics server-side
		updatePlayerPhysics(player, deltaTime);

		// Send position correction to client
		if (player.connection.readyState === 1) { // WebSocket.OPEN
			player.connection.send(JSON.stringify({
				type: 'position:update',
				pos: {
					x: player.pos.x,
					z: player.pos.z
				},
				heading: player.heading,
				bankAngle: player.bankAngle
			}));
		}
	});
}, 16);