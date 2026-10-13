import { loadConfig } from './config.js';
import { createGameServerApp } from './gameserver.js';

const config = await loadConfig();
const gameServer = createGameServerApp(config);
const server = gameServer.app.listen(config.gameServer.port, config.gameServer.bindHost, () => {
  console.log(`[gameserver-adapter] HTTP listening on http://${config.gameServer.bindHost}:${config.gameServer.port}`);
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
