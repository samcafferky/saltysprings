'use strict';

const express = require('express');
const { requireAuth, requireSelf } = require('../middleware/auth');
const { errors } = require('../utils/errors');
const { uuid } = require('../utils/ids');

module.exports = function matchmakingRoutes(services, config) {
  const router = express.Router();
  const auth = requireAuth(services);
  const authAny = requireAuth(services, { allowClient: true });

  router.get('/fortnite/api/game/v2/matchmakingservice/ticket/player/:accountId', auth, requireSelf(), (req, res) => {
    const ticket = services.matchmaking.createTicket(req.account.id, req.query);
    res.json({
      serviceUrl: `ws://${config.server.publicHost}:${config.server.port}/matchmaking`,
      ticketType: 'mms-player',
      payload: ticket.payload,
      signature: ticket.signature,
    });
  });

  router.get('/fortnite/api/game/v2/matchmaking/account/:accountId/session/:sessionId', auth, requireSelf(), (req, res) =>
    res.json({ accountId: req.params.accountId, sessionId: req.params.sessionId, key: 'none' }),
  );

  router.get('/fortnite/api/matchmaking/session/findPlayer/:accountId', authAny, (req, res) => res.json([]));
  router.post('/fortnite/api/matchmaking/session/matchMakingRequest', authAny, (req, res) => res.json([]));

  router.get('/fortnite/api/matchmaking/session/:sessionId', authAny, (req, res, next) => {
    const session = services.matchmaking.getSession(req.params.sessionId);
    if (!session) return next(errors.notFound());
    const { server } = session;
    res.json({
      id: req.params.sessionId,
      ownerId: uuid().replace(/-/g, '').toUpperCase(),
      ownerName: '[DS]ogfn-server',
      serverName: '[DS]ogfn-server',
      serverAddress: server.ip,
      serverPort: Number(server.port),
      maxPublicPlayers: server.maxPlayers || 100,
      openPublicPlayers: server.maxPlayers || 100,
      maxPrivatePlayers: 0,
      openPrivatePlayers: 0,
      attributes: {
        REGION_s: session.region,
        GAMEMODE_s: 'FORTATHENA',
        ALLOWBROADCASTING_b: true,
        SUBREGION_s: session.region,
        DCID_s: 'OGFN-SERVER',
        tenant_s: 'Fortnite',
        MATCHMAKINGPOOL_s: 'Any',
        STORMSHIELDDEFENSETYPE_i: 0,
        HOTFIXVERSION_i: 0,
        PLAYLISTNAME_s: session.playlist,
        SESSIONKEY_s: uuid().replace(/-/g, '').toUpperCase(),
        TENANT_s: 'Fortnite',
        BEACONPORT_i: 15009,
      },
      publicPlayers: [],
      privatePlayers: [],
      totalPlayers: 0,
      allowJoinInProgress: false,
      shouldAdvertise: false,
      isDedicated: false,
      usesStats: false,
      allowInvites: false,
      usesPresence: false,
      allowJoinViaPresence: true,
      allowJoinViaPresenceFriendsOnly: false,
      buildUniqueId: session.buildId,
      lastUpdated: new Date().toISOString(),
      started: false,
    });
  });

  router.post('/fortnite/api/matchmaking/session/:sessionId/join', authAny, (req, res) => res.status(204).end());

  // Party service (Season 8+ clients). Parties use XMPP on this server, so these stay empty.
  router.get('/party/api/v1/Fortnite/user/:accountId', auth, (req, res) =>
    res.json({ current: [], pending: [], invites: [], pings: [] }),
  );
  router.get('/party/api/v1/Fortnite/user/:accountId/notifications/undelivered/count', auth, (req, res) =>
    res.json({ pings: 0, invites: 0 }),
  );

  return router;
};
