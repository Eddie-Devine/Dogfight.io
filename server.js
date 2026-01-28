const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const JWT = require('jsonwebtoken');

const PORT = 3000;
const JWT_SECRET = 'DEV_ONLY_CHANGE_ME';

const VALID_GAMEMODES = ['freeforall'];
const FREE_JETS = ['F22'];
const DEFAULT_CALLSIGNS = [
	'Maverick', 'Iceman', 'Goose', 'Viper', 'Jester',
	'Cougar', 'Merlin', 'Sundown', 'Chipper', 'Hollywood'
];

const app = express();
expressWs(app);

const room = {
	freeforall: new Map()
}

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

app.ws('/game/freeforall', (ws, req) => {
	const token = req.query.token;

	// Server keeps these constants
	const WORLD_SIZE = 5000;

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

	ws.send(JSON.stringify({
		type: 'session:init',
		callsign: playerData.callsign,
		gamemode: playerData.gamemode,
		jet: playerData.jet,
		pos: {
			x: 0,
			y: 0
		},
		worldSize: WORLD_SIZE
	}));

	console.log(JSON.stringify({
		type: 'session:init',
		callsign: playerData.callsign,
		gamemode: playerData.gamemode,
		jet: playerData.jet,
		pos: {
			x: 0,
			y: 0
		},
		worldSize: WORLD_SIZE
	}));

	ws.on('message', (message) => {

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

app.get('*', (req, res) => {
	res.sendFile(path.join(__dirname, 'Public', 'index.html'));
});

app.listen(PORT, () => {
	console.log(`Server on port ${PORT}`);
});
