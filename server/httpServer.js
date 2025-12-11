const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const favicon = require('serve-favicon');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const jetsCatalog = require(path.join(__dirname, '..', 'public', 'MainMenu', 'jets-data.js'));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SSL_DIR = path.join(__dirname, '..', 'SSL');

const JETS_ARRAY = Array.isArray(jetsCatalog?.Jets) ? jetsCatalog.Jets : [];
const JET_WHITELIST = new Set(JETS_ARRAY.map(j => j && j.ID).filter(Boolean));
const JETS_BY_ID = new Map(JETS_ARRAY.map(j => [j.ID, j]));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const SESSION_COOKIE = 'df_session';
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';

const requireSession = (req, res, next) => {
	const token = req.cookies[SESSION_COOKIE];
	if (!token) return res.redirect('/MainMenu/');

	try {
		req.player = jwt.verify(token, JWT_SECRET);
		return next();
	} catch {
		res.clearCookie(SESSION_COOKIE, { path: '/' });
		return res.redirect('/MainMenu/');
	}
};

function buildApp() {
	const app = express();

	app.use(helmet());
	app.use(cors());
	app.use(express.json());
	app.use(morgan('dev'));
	app.use(favicon(path.join(PUBLIC_DIR, 'Assets', 'Favicon.ico')));
	app.use(cookieParser());

	app.use('/Game', requireSession, express.static(path.join(PUBLIC_DIR, 'Game'), { maxAge: '1d' }));

	app.get('/game', requireSession, (req, res) => {
		res.sendFile(path.join(PUBLIC_DIR, 'Game', 'index.html'));
	});

	app.use('/MainMenu', express.static(path.join(PUBLIC_DIR, 'MainMenu'), { maxAge: '1d' }));
	app.use(express.static(PUBLIC_DIR, { maxAge: '1d' }));

	app.get('/', (req, res) => {
		res.sendFile(path.join(PUBLIC_DIR, 'MainMenu', 'index.html'));
	});

	app.post('/session/start', (req, res) => {
		const { name, jet } = req.body || {};

		const validName = typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 16;
		const validJet = typeof jet === 'string' && JET_WHITELIST.has(jet);

		if (!validName || !validJet) {
			return res.status(400).json({ ok: false, error: 'Invalid name or jet.' });
		}

		const payload = { name: name.trim(), jet };
		const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '2h' });

		res.cookie(SESSION_COOKIE, token, {
			httpOnly: true,
			secure: COOKIE_SECURE,
			sameSite: 'lax',
			maxAge: 2 * 60 * 60 * 1000,
			path: '/',
		});

		return res.json({ ok: true });
	});

	app.get('/api/jet', requireSession, (req, res) => {
		try {
			const jetId = req.player?.jet;
			if (!jetId) return res.status(400).json({ error: 'Missing jet identifier in session' });

			const jet = JETS_BY_ID.get(jetId);
			if (!jet) return res.status(404).json({ error: 'Jet not found' });

			return res.json(jet);
		} catch (err) {
			return res.status(500).json({ error: 'Failed to resolve jet' });
		}
	});

	return app;
}

function createCredentials(keyPath, certPath) {
	try {
		return {
			key: fs.readFileSync(keyPath),
			cert: fs.readFileSync(certPath),
		};
	} catch {
		return null;
	}
}

function createHttpServer(options = {}) {
	const app = buildApp();

	const port = Number(options.port || process.env.HTTP_PORT || process.env.PORT || 3000);
	const envHttps = process.env.USE_HTTPS;
	const useHttps = options.useHttps ?? (envHttps ? envHttps !== 'false' : true);
	const keyPath = options.keyPath || process.env.HTTPS_KEY || path.join(SSL_DIR, 'key.pem');
	const certPath = options.certPath || process.env.HTTPS_CERT || path.join(SSL_DIR, 'cert.pem');

	let server;
	if (useHttps) {
		const creds = createCredentials(keyPath, certPath);
		if (!creds) {
			throw new Error(`HTTPS requested but SSL certs not found at ${keyPath} / ${certPath}`);
		}
		server = https.createServer(creds, app);
	} else {
		console.warn('Starting HTTP server without TLS (set USE_HTTPS=true or provide certs to enable HTTPS).');
		server = http.createServer(app);
	}

	server.listen(port, () => {
		const protocol = useHttps ? 'https' : 'http';
		console.log(`${protocol.toUpperCase()} server listening on ${protocol}://localhost:${port}`);
	});

	return { app, server };
}

module.exports = {
	createHttpServer,
	requireSession,
	JETS_BY_ID,
	JET_WHITELIST,
	SESSION_COOKIE,
	JWT_SECRET,
};
