import { createRemoteConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { createRemoteRelayServer } from './server.js';

const config = createRemoteConfig();
const logger = createLogger({ level: config.logLevel, name: 'remote-relay' });
const server = createRemoteRelayServer(config, { logger });

server.listen(config.port, config.host, () => {
  logger.info('remote_relay_started', {
    host: config.host,
    port: config.port,
    relayPath: config.relayPath,
    upstreamRouting: config.upstreamRouting,
    upstreamProvider: config.upstreamProvider,
    upstreamBaseUrl: config.upstreamBaseUrl
  });
});

function shutdown() {
  logger.info('remote_relay_stopping');
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
