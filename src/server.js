'use strict';

const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');

const { openDatabase } = require('./db/database');
const { createApp } = require('./app');
const ids = require('./utils/ids');
const { AccountService } = require('./services/accounts');
const { TokenService } = require('./services/tokens');
const { ProfileService } = require('./services/profiles');
const { FriendService } = require('./services/friends');
const { CatalogService } = require('./services/catalog');
const { CosmeticsService } = require('./services/cosmetics');
const { MatchmakingService } = require('./services/matchmaking');
const { PartyService } = require('./services/parties');
const { XmppServer } = require('./xmpp/server');
const { handleMatchmaker } = require('./matchmaker/server');

function createServices(config, logger = console) {
  const dbPath = config.database.path === ':memory:' ? ':memory:' : path.resolve(config.root, config.database.path);
  const db = openDatabase(dbPath);
  const events = new EventEmitter();
  const accounts = new AccountService(db);
  const cosmetics = new CosmeticsService(config, logger);
  return {
    db,
    config,
    logger,
    events,
    ids,
    accounts,
    cosmetics,
    tokens: new TokenService(db, config.auth),
    profiles: new ProfileService(db, config, cosmetics),
    friends: new FriendService(db, accounts, events),
    catalog: new CatalogService(config),
    matchmaking: new MatchmakingService(db, config),
    parties: new PartyService(accounts, events),
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

async function startServer(config, { logger = console } = {}) {
  const services = createServices(config, logger);
  const app = createApp(services, config);
  const xmpp = new XmppServer(services, config);
  services.xmpp = xmpp;

  // One websocket server handles both XMPP and the matchmaker; the
  // "Sec-WebSocket-Protocol: xmpp" header tells them apart.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const onUpgrade = (req, socket, head) => {
    const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map((p) => p.trim());
    const isXmpp = protocols.includes('xmpp');
    const isMatchmaker = String(req.headers.authorization || '').startsWith('Epic-Signed');
    if ((isXmpp && !config.xmpp.enabled) || (!isXmpp && !isMatchmaker)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (isXmpp) xmpp.handleConnection(ws);
      else handleMatchmaker(ws, req, services);
    });
  };

  const httpServer = http.createServer(app);
  httpServer.on('upgrade', onUpgrade);
  const port = await listen(httpServer, config.server.port, config.server.host);
  config.server.port = port;
  logger.log(`[server] backend listening on http://${config.server.host}:${port}`);

  // Fortnite reads the XMPP address from DefaultEngine.ini (default port 80).
  let xmppServer = null;
  if (config.xmpp.enabled && config.xmpp.port !== port) {
    xmppServer = http.createServer((req, res) => res.writeHead(426).end());
    xmppServer.on('upgrade', onUpgrade);
    try {
      config.xmpp.port = await listen(xmppServer, config.xmpp.port, config.server.host);
      logger.log(`[server] xmpp listening on ws://${config.server.host}:${config.xmpp.port}`);
    } catch (err) {
      logger.warn(`[server] could not open xmpp port ${config.xmpp.port} (${err.code}). XMPP still works on port ${port}; set xmpp.port in config.json to change it.`);
      xmppServer = null;
      config.xmpp.port = port;
    }
  }

  if (config.game.giveAllCosmetics) services.cosmetics.init();
  const purgeTimer = setInterval(() => services.tokens.purgeExpired(), 10 * 60 * 1000);
  purgeTimer.unref();

  return {
    services,
    port,
    xmppPort: config.xmpp.port,
    async close() {
      clearInterval(purgeTimer);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => httpServer.close(r));
      if (xmppServer) await new Promise((r) => xmppServer.close(r));
      services.db.close();
    },
  };
}

module.exports = { startServer, createServices };
