'use strict';

const { loadConfig } = require('./config');
const { startServer } = require('./server');

startServer(loadConfig()).then((server) => {
  const shutdown = async () => {
    console.log('[server] shutting down');
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}).catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
