import { loadConfig } from './config.js';
import { createBackend } from './server.js';

const config = await loadConfig();
const backend = await createBackend(config);
const backendServer = backend.app.listen(config.server.port, config.server.host, () => {
  console.log(`[backend] HTTP listening on http://${config.server.host}:${config.server.port}`);
});
backendServer.on('upgrade', backend.handleUpgrade);
if (backend.gameServer) {
  const gameServerHttp = backend.gameServer.app.listen(config.gameServer.port, config.gameServer.bindHost, () => {
    console.log(`[gameserver-adapter] HTTP listening on http://${config.gameServer.bindHost}:${config.gameServer.port}`);
  });
  backend.gameServer.httpServer = gameServerHttp;
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[server] received ${signal}; shutting down gracefully`);
  backend.services.matchmaker.stop();
  clearInterval(backend.authCleanupTimer);
  const closing = [];
  for (const server of [backend.gameServer?.httpServer, backendServer].filter(Boolean)) {
    closing.push(new Promise((resolve) => server.close(() => resolve())));
  }
  await Promise.all(closing);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => console.error('[server] unhandled rejection:', error));
