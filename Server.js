//Dependencies
const express = require('express'); //Express framework for HTTP server
const https = require('https'); //HTTPS module for secure server
const path = require('path'); //Path module for handling file paths
const cors = require('cors'); //Cross-Origin Resource Sharing middleware
const helmet = require('helmet'); //Security middleware
const morgan = require('morgan'); //HTTP request logger middleware
const { WebSocketServer } = require('ws'); //WebSocket server module
const fs = require('fs'); //File system module
const favicon = require('serve-favicon'); //Favicon middleware
const cookieParser = require('cookie-parser'); //Parses cookies
const jwt = require('jsonwebtoken'); //handles JWT verification and signing
const jetsCatalog = require(path.join(__dirname, 'public', 'API', 'jets.json')); // Jet catalog

// Precompute jet collections from catalog
const JETS_ARRAY = Array.isArray(jetsCatalog?.Jets) ? jetsCatalog.Jets : [];
const JET_WHITELIST = new Set(JETS_ARRAY.map(j => j && j.ID).filter(Boolean));
const JETS_BY_ID = new Map(JETS_ARRAY.map(j => [j.ID, j]));

const app = express(); //Create Express app

//SSL Credentials
const creds = {
	key: fs.readFileSync('./SSL/key.pem'),
	cert: fs.readFileSync('./SSL/cert.pem'),
};

//Jason Web Token (JWT)
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const SESSION_COOKIE = 'df_session'; // name your cookie

//Session middleware to protect game
const requireSession = (req, res, next) => {
	const token = req.cookies[SESSION_COOKIE];
	if (!token) return res.redirect('/MainMenu/'); // or '/'

	try {
		req.player = jwt.verify(token, JWT_SECRET); // { name, jet, role, iat, exp }
		return next();
	} catch {
		res.clearCookie(SESSION_COOKIE, { path: '/' });
		return res.redirect('/MainMenu/');
	}
}

//Middleware
app.use(helmet()); //Adds security headers for HTTP
app.use(cors()); //Blocks API requests from unauthorized domains
app.use(express.json()); //Parses JSON request bodies
app.use(morgan('dev')); //Logs HTTP requests to console
app.use(favicon(path.join(__dirname, 'public', 'Assets', 'Favicon.ico'))); //Serves favicon
app.use(cookieParser()); //Parses cookies from HTTP requests

// Game files requiure a session
app.use('/Game', requireSession, express.static(path.join(__dirname, 'public', 'Game'), {
	maxAge: '1d'
}));

// Game endpoint (requires session)
app.get('/game', requireSession, (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'Game', 'index.html'));
});

// Serve main menu and prevent 404
app.use('/MainMenu', express.static(path.join(__dirname, 'public', 'MainMenu'), { maxAge: '1d' }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

// Default REST endpoint serves main menu
app.get('/', (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'MainMenu', 'index.html'));
});

// Start session by getting token
app.post('/session/start', (req, res) => {
	const { name, jet } = req.body || {};

	// Server-side validation (don’t trust the client)
	const validName = typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 16;
	const validJet = typeof jet === 'string' && JET_WHITELIST.has(jet);

	if (!validName || !validJet) {
		return res.status(400).json({ ok: false, error: 'Invalid name or jet.' });
	}

	const payload = { name: name.trim(), jet};
	const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '2h' });

	// HttpOnly cookie so JS can’t tamper; secure: true because you’re on HTTPS
	res.cookie(SESSION_COOKIE, token, {
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		maxAge: 2 * 60 * 60 * 1000,
		path: '/',
	});

	return res.json({ ok: true });
});

//give the user their jet data based on jet id in JWT
app.get('/api/jet', requireSession, (req, res) => {
	try {
		const jetId = req.player?.jet; // ID stored in JWT payload
		if (!jetId) return res.status(400).json({ error: 'Missing jet identifier in session' });

		const jet = JETS_BY_ID.get(jetId);
		if (!jet) return res.status(404).json({ error: 'Jet not found' });

		return res.json(jet);
	} catch (err) {
		return res.status(500).json({ error: 'Failed to resolve jet' });
	}
});

// HTTP server for Express
const server = https.createServer(creds, app);

// WebSocket server on same HTTP server
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
	ws.send(JSON.stringify({ type: 'welcome', message: 'Connected to WebSocket server' }));

	ws.on('message', (data) => {
		return;
	});

	ws.on('close', () => {
		// Handle disconnect if needed
		return;
	});
});

wss.on('close', () => clearInterval(interval));

const PORT = process.env.PORT || 3000; //Run on designated port or 3000
server.listen(PORT, () => { //Start server on port
	console.log(`HTTPS listening securely on https://localhost:${PORT}`);
	console.log(`WebSocket path wss://localhost:${PORT}/ws`);
	if (!process.env.JWT_SECRET) console.log('⚠️  Warning: Using dev-only JWT secret');
});

// Graceful shutdown
process.on('SIGINT', () => {
	console.log('Shutting down...');
	server.close(() => process.exit(0));
	for (const ws of wss.clients) ws.terminate();
});
