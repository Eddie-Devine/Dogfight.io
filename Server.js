const { createHttpServer } = require('./server/httpServer');
const { createWebSocketServer } = require('./server/websocketServer');

const httpServer = createHttpServer();
const wsServer = createWebSocketServer();

function shutdown(code = 0) {
	console.log('Shutting down...');

	if (wsServer?.wss) {
		for (const client of wsServer.wss.clients) client.terminate();
		wsServer.server.close();
	}

	if (httpServer?.server) {
		httpServer.server.close(() => process.exit(code));
	} else {
		process.exit(code);
	}
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (err) => {
	console.error('Uncaught exception:', err);
	shutdown(1);
});
