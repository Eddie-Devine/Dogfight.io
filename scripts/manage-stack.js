#!/usr/bin/env node

/**
 * Simple helper to start/stop the Dogfight stack (nginx + Node backends).
 *
 * Usage:
 *   node scripts/manage-stack.js start   # default, also used by npm start
 *   node scripts/manage-stack.js stop    # stops nginx if it was left running
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NGINX_PREFIX = path.join(ROOT, '.dev-nginx');
const NGINX_CONF = path.join(ROOT, 'nginx.conf');
const NGINX_PIDFILE = path.join(NGINX_PREFIX, 'logs', 'nginx.pid');

const mode = (process.argv[2] || 'start').toLowerCase();

function ensurePrefixDirs() {
	fs.mkdirSync(path.join(NGINX_PREFIX, 'logs'), { recursive: true });
	fs.mkdirSync(path.join(NGINX_PREFIX, 'client_body_temp'), { recursive: true });
	fs.mkdirSync(path.join(NGINX_PREFIX, 'proxy_temp'), { recursive: true });
}

function stopNginx(verbose = true) {
	let pid = null;
	if (fs.existsSync(NGINX_PIDFILE)) {
		pid = fs.readFileSync(NGINX_PIDFILE, 'utf8').trim();
	}

	if (!pid) {
		const res = spawnSync('pgrep', ['-f', `nginx: master process nginx -p ${NGINX_PREFIX}`], { encoding: 'utf8' });
		if (res.status === 0 && res.stdout.trim()) {
			pid = res.stdout.trim().split('\n')[0];
		}
	}

	if (!pid) {
		if (verbose) console.log('nginx not running.');
		return;
	}

	try {
		process.kill(pid, 'SIGTERM');
	} catch (err) {
		console.warn(`Failed to stop nginx pid ${pid}:`, err.message);
	}
}

function killNodeProcesses() {
	const res = spawnSync('pkill', ['-f', 'node Server.js'], { stdio: 'ignore' });
	if (res.error && res.error.code !== 'ENOENT') {
		console.warn('Failed to run pkill for node Server.js:', res.error.message);
	}
}

if (mode === 'stop') {
	killNodeProcesses();
	stopNginx();
	process.exit(0);
}

if (!fs.existsSync(NGINX_CONF)) {
	console.error(`Missing nginx.conf at ${NGINX_CONF}.`);
	process.exit(1);
}

ensurePrefixDirs();
stopNginx(false); // best effort cleanup from previous run
killNodeProcesses();

const test = spawnSync('nginx', ['-t', '-p', NGINX_PREFIX, '-c', NGINX_CONF], { stdio: 'inherit' });
if (test.status !== 0 || test.error) {
	console.error('nginx config test failed.');
	process.exit(test.status || 1);
}

console.log('Starting nginx...');
const nginx = spawn('nginx', ['-p', NGINX_PREFIX, '-c', NGINX_CONF], { stdio: 'inherit' });

let nodeProc = null;
let shuttingDown = false;

function shutdown(code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log('Shutting down stack...');
	if (nodeProc && !nodeProc.killed) {
		nodeProc.kill('SIGINT');
	}
	stopNginx();
	process.exit(code);
}

nginx.on('exit', (code) => {
	if (code !== 0) {
		console.error(`nginx exited with code ${code}`);
		shutdown(code || 1);
	}
});

console.log('Starting Node server...');
nodeProc = spawn('node', ['Server.js'], { cwd: ROOT, stdio: 'inherit' });

nodeProc.on('exit', (code) => {
	stopNginx();
	process.exit(code || 0);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (err) => {
	console.error('Unhandled error:', err);
	shutdown(1);
});
