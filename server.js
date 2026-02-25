const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const JWT = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');

const updatePlayerPhysics = require('./serverPhysics.js');
const JET_CONFIG = require('./jetConfig.json');

//load default callsigns from txt
let DEFAULT_CALLSIGNS = ['ERROR: NO DEFAULT CALLSIGNS'];
try {
    const data = fs.readFileSync('defaultCallsigns.txt', 'utf-8');
    DEFAULT_CALLSIGNS = data.split(/\r?\n/);
} catch (error) {
    console.log(error);
}

//TEMPERARY: replacement for ENV variables
const PORT = 3000;
const JWT_SECRET = 'DEV_ONLY_CHANGE_ME';

const VALID_GAMEMODES = ['freeforall'];
const VIEW_DISTANCE = 3000; //max viewing distance for visual contacts
const VIEW_DISTANCE_SQ = VIEW_DISTANCE * VIEW_DISTANCE; //calculated here to avoid re-running arithmic in the loop
const FREE_JETS = ['F22', 'A10']; //jets that don't need extra validation to play

//Each game room for different game modes
const room = {
	freeforall: {
		worldSize: 30000,
		stormSize: 20000,
		players: new Map(),
		spacialMap: new Map()
	}
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

function getRandomcordinates(boundry) {
	//boundry is cut in half because (0,0) is center for client but on server it is the top left
	const half = boundry / 2;
	const x = Math.floor(Math.random() * (boundry - half));
	const z = Math.floor(Math.random() * (boundry - half));
	return { x, z };
}

function getChunkCoordinates(x, z) {
	const CHUNK_SIZE = VIEW_DISTANCE;
	return {
		chunkX: Math.floor(x / CHUNK_SIZE),
		chunkZ: Math.floor(z / CHUNK_SIZE)
	};
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
	const players = room.freeforall.players;
	const WORLD_SIZE = room.freeforall.worldSize;

	let playerID; // or crypto.randomBytes(16).toString('hex')
	do { //loop in case ID is taken
		playerID = crypto.randomUUID();
	} while (players.has(playerID));

	//const { x: playerX, z: playerZ } = randomCordinates(WORLD_SIZE);
	playerX = 0;
	playerZ = 0;

	players.set(playerID, {
		connection: ws,
		isReady: false,
		callsign: playerData.callsign,
		jet: playerData.jet,
		position: {
			x: playerX,
			z: playerZ,
			chunkX: null,
			chunkZ: null
		},
		input: {
			aimAngle: 0,
			throttle: 0,
			seq: 0,
			lastInputAt: Date.now()
		},
		speed: JET_CONFIG[playerData.jet].minSpeed,
		heading: 180, //degrees
		bankAngle: 0,
		lastUpdate: Date.now()
	});

	const player = players.get(playerID);

	// ws.send(JSON.stringify({
	// 	type: 'session:init',
	// 	callsign: playerData.callsign,
	// 	playerID,
	// 	gamemode: playerData.gamemode,
	// 	jet: playerData.jet,
	// 	position: {
	// 		x: playerX,
	// 		z: playerZ
	// 	},
	// 	worldSize: WORLD_SIZE,
	// }));

	ws.send(JSON.stringify({
		type: 'session:init',
		callsign: playerData.callsign,
		jet: playerData.jet,
		position: {
			x: playerX,
			z: playerZ
		},
		speed: JET_CONFIG[playerData.jet].minSpeed,
		heading: 180, //degrees
		bankAngle: 0,
		worldSize: WORLD_SIZE,
		gamemode: playerData.gamemode,
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
			if (player.isReady) return;

			player.lastUpdate = Date.now();

			player.isReady = true;

			player.connection.send(JSON.stringify({
				type: 'position:update',
				position: { x: player.position.x, z: player.position.z },
				heading: player.heading,
				bankAngle: player.bankAngle
			}));
		}

		if (data.type === 'input:update') {
			if (!player.isReady) return; //wait for player to load before accepting movement

			const aimAngle = data?.input?.aimAngle;
			const throttle = data?.input?.throttle;
			const seq = data?.seq;

			if (!Number.isFinite(aimAngle) || !Number.isFinite(throttle) || !Number.isFinite(seq)) return; //prevent bad data from crashing server

			const lastSeq = player.input.seq;
			if (seq <= lastSeq) return; //drop duplicate/old packet

			player.input.aimAngle = aimAngle;
			player.input.throttle = Math.max(0, Math.min(1, throttle));
			player.input.seq = seq;
			player.input.lastInputAt = Date.now();
		}

		if (data.type === 'radar:request') {
			if (!player.isReady) return;

			const radarDistance = JET_CONFIG[player.jet].radarDistance;

			const radarContacts = Array.from(players.entries())
				.filter(([id]) => id !== playerID) //filter self from list
				.map(([, remotePlayer]) => {
					const dx = remotePlayer.position.x - player.position.x;
					const dz = remotePlayer.position.z - player.position.z;
					const distance = Math.hypot(dx, dz);

					if (distance <= radarDistance) {
						return [remotePlayer.position.x, remotePlayer.position.z];
					}
				})
				.filter(Boolean); // remove undefined entries

			player.connection.send(JSON.stringify({
				type: 'radar:update',
				radarContacts
			}));
		}
	});

	ws.on('close', () => {
		players.delete(playerID);
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

	res.json({ token, gamemode, jet });
});

//TEMPERARY
app.get('/jetConfig', (req, res) => {
	res.send(JSON.stringify(JET_CONFIG));
});

//404 just sends users to main menu
app.get('*', (req, res) => {
	res.redirect('/');
});

app.listen(PORT, () => {
	console.log(`Server on port ${PORT}`);
});


//free for all game tick
setInterval(() => {
	const players = room.freeforall.players; //map of all player states
	const now = Date.now();

	//Update physics
	players.forEach(player => {
		if (!player.isReady) return;

		let deltaTime = (now - player.lastUpdate) / 1000;
		deltaTime = Math.min(deltaTime, 300); //cap deltaTime

		const config = JET_CONFIG[player.jet];
		updatePlayerPhysics(player, config, deltaTime);
		player.lastUpdate = now;

		//cache chunk to avoid recomuting
		const { chunkX, chunkZ } = getChunkCoordinates(player.position.x, player.position.z);
        player.position.chunkX = chunkX;
		player.position.chunkZ = chunkZ;
	});

	//build spacial map
	const spatialMap = room.freeforall.spacialMap;
	spatialMap.clear();
    players.forEach((player, id) => {
        const key = `${player.position.chunkX},${player.position.chunkZ}`;
        let chunk = spatialMap.get(key);
        if (!chunk) {
            chunk = [];
            spatialMap.set(key, chunk);
        }
        chunk.push({ id, player });
    });

	// Send updates
	players.forEach(player => {
		if (!player.isReady) return;
		if (player.connection.readyState !== 1) return;

		const { chunkX, chunkZ } = player.position;
		const nearbyPlayers = []; //visual contacts

		//for loop and nested for loop check 3x3 grid of chunks (x,z)
		for (let x = -1; x <= 1; x++) { //checks horizontally
			for (let z = -1; z <= 1; z++) { //checks virtically
				const key = `${chunkX + x},${chunkZ + z}`;
				const chunk = spatialMap.get(key);
				if (!chunk) continue;

				//loop through players in chunk
				for (const { id: remotePlayerId, player: remotePlayer } of chunk) {
					if (remotePlayer === player) continue; //ignore the reciepent

					//distance to remote player
					const dx = remotePlayer.position.x - player.position.x;
					const dz = remotePlayer.position.z - player.position.z;

					//ignore players too far away to see
					if ((dx * dx + dz * dz) > VIEW_DISTANCE_SQ) continue; 

					//add santitized player object to send to client
					nearbyPlayers.push({
						id: remotePlayerId,
						jet: remotePlayer.jet,
						position: {
							x: remotePlayer.position.x,
							z: remotePlayer.position.z
						},
						heading: remotePlayer.heading,
						bankAngle: remotePlayer.bankAngle,
						speed: remotePlayer.speed
					});
				}
			}
		}

		player.connection.send(JSON.stringify({
			type: 'world:update',
			seq: player.input.seq,
			self: {
				position: {
					x: player.position.x,
					z: player.position.z
				},
				heading: player.heading,
				bankAngle: player.bankAngle,
				speed: player.speed
			},
			visualContacts: nearbyPlayers
		}));
	});

}, 16);