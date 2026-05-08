import { createLocalConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { RelayClient } from './relayClient.js';
import { createLocalProxyServer } from './server.js';

const config = createLocalConfig();
const logger = createLogger({ level: config.logLevel, name: 'local-proxy' });
const relayClient = new RelayClient(config, { logger });
const server = createLocalProxyServer(config, { relayClient, logger });

server.listen(config.port, config.host, () => {
  logger.info('local_proxy_started', {
    host: config.host,
    port: config.port,
    relayUrl: config.relayUrl
  });
});

async function shutdown() {
  logger.info('local_proxy_stopping');
  await relayClient.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
