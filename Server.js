//Dependencies
const express = require('express'); //Express framework for HTTP server
const https = require('https'); //HTTPS module for secure server
const path = require('path'); //Path module for handling file paths
const cors = require('cors'); //Cross-Origin Resource Sharing middleware
const helmet = require('helmet'); //Security middleware
const morgan = require('morgan'); //HTTP request logger middleware
const { WebSocketServer } = require('ws'); //WebSocket server module
const fs = require('fs'); //File system module

const app = express();

//SSL Credentials
const creds = {
	key: fs.readFileSync('./SSL/key.pem'),
	cert: fs.readFileSync('./SSL/cert.pem'),
};

//Middleware
app.use(helmet()); //Adds security headers for HTTP
app.use(cors()); //Blocks API requests from unauthorized domains
app.use(express.json()); //Parses JSON request bodies
app.use(morgan('dev')); //Logs HTTP requests to console

// Default REST endpoint
app.get('/', (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'MainMenu', 'index.html'));
});

// Serve static files from public
app.use(express.static(path.join(__dirname, 'public')));

// HTTP server for Express
const server = https.createServer(creds, app);

// WebSocket server on same HTTP server
const wss = new WebSocketServer({ server, path: '/ws' });

function noop() { }
function heartbeat() {
	this.isAlive = true;
}

wss.on('connection', (ws, req) => {
	ws.isAlive = true;
	ws.on('pong', heartbeat);

	ws.send(JSON.stringify({ type: 'welcome', message: 'Connected to WebSocket server' }));

	ws.on('message', (data) => {
		let payload = data;
		try {
			payload = JSON.parse(data);
		} catch (_) {
			payload = { type: 'message', text: String(data) };
		}

		const enriched = {
			...payload,
			ts: Date.now(),
			from: req.socket.remoteAddress,
		};

		for (const client of wss.clients) {
			if (client.readyState === 1) {
				client.send(JSON.stringify(enriched));
			}
		}
	});

	ws.on('close', () => {
		// Handle disconnect if needed
	});
});

// Heartbeat cleanup
const interval = setInterval(() => {
	for (const ws of wss.clients) {
		if (ws.isAlive === false) { ws.terminate(); continue; }
		ws.isAlive = false;
		ws.ping(noop);
	}
}, 30000);

wss.on('close', () => clearInterval(interval));

const PORT = process.env.PORT || 3000; //Run on designated port or 3000
server.listen(PORT, () => { //Start server on port
	console.log(`HTTPS listening securely on https://localhost:${PORT}`);
	console.log(`WebSocket path wss://localhost:${PORT}/ws`);
});

// Graceful shutdown
process.on('SIGINT', () => {
	console.log('Shutting down...');
	server.close(() => process.exit(0));
	for (const ws of wss.clients) ws.terminate();
});