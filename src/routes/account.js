'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { errors } = require('../utils/errors');

const APP_ID = 'fghi4567FNFBKFz3E4TROb0bmPS8h1GW';

// "Authorization: basic base64(clientId:secret)". Any client id is accepted.
function readClientId(req) {
  const match = (req.headers.authorization || '').match(/^basic\s+(.+)$/i);
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  return decoded.split(':')[0] || null;
}

function publicAccount(account) {
  return { id: account.id, displayName: account.displayName, externalAuths: {} };
}

module.exports = function accountRoutes(services, config) {
  const router = express.Router();
  const auth = requireAuth(services);
  const authAny = requireAuth(services, { allowClient: true });
  const loginLimit = rateLimit({ windowMs: 60_000, max: config.server.rateLimits.loginPerMinute });

  function sessionResponse(account, clientId, session, deviceId) {
    return {
      access_token: `eg1~${session.access.token}`,
      expires_in: Math.round((session.access.expiresAt - Date.now()) / 1000),
      expires_at: new Date(session.access.expiresAt).toISOString(),
      token_type: 'bearer',
      refresh_token: `eg1~${session.refresh.token}`,
      refresh_expires: Math.round((session.refresh.expiresAt - Date.now()) / 1000),
      refresh_expires_at: new Date(session.refresh.expiresAt).toISOString(),
      account_id: account.id,
      client_id: clientId,
      internal_client: true,
      client_service: 'fortnite',
      displayName: account.displayName,
      app: 'fortnite',
      in_app_id: account.id,
      device_id: deviceId,
      product_id: 'prod-fn',
      application_id: APP_ID,
    };
  }

  router.post('/account/api/oauth/token', loginLimit, (req, res, next) => {
    const body = req.body || {};
    const clientId = readClientId(req);
    if (!clientId) {
      return next(
        errors.badRequest('It appears that your Authorization header may be invalid or not present, please verify that you are sending the correct headers.'),
      );
    }
    const deviceId = req.headers['x-epic-device-id'] || services.ids.hexId();

    let account;
    let authMethod = body.grant_type;
    switch (body.grant_type) {
      case 'client_credentials': {
        const client = services.tokens.issueClient(clientId);
        return res.json({
          access_token: `eg1~${client.token}`,
          expires_in: Math.round((client.expiresAt - Date.now()) / 1000),
          expires_at: new Date(client.expiresAt).toISOString(),
          token_type: 'bearer',
          client_id: clientId,
          internal_client: true,
          client_service: 'fortnite',
        });
      }
      case 'password': {
        if (!body.username || !body.password) return next(errors.badRequest('username and password are required'));
        account = services.accounts.checkCredentials(body.username, body.password);
        if (!account) return next(errors.invalidCredentials());
        break;
      }
      case 'exchange_code': {
        const code = services.tokens.consume(String(body.exchange_code || ''), 'exchange');
        if (!code) return next(errors.invalidGrant('Sorry the exchange code you supplied was not found. It is possible that it was no longer valid'));
        account = services.accounts.findById(code.accountId);
        break;
      }
      case 'refresh_token': {
        const raw = String(body.refresh_token || '').replace(/^eg1~/, '');
        const refresh = services.tokens.consume(raw, 'refresh');
        if (!refresh) return next(errors.invalidGrant(`Sorry the refresh token '${raw}' is invalid`));
        services.tokens.revokeSession(refresh.sessionId);
        account = services.accounts.findById(refresh.accountId);
        authMethod = refresh.authMethod;
        break;
      }
      default:
        return next(errors.unsupportedGrant(body.grant_type));
    }

    if (!account) return next(errors.invalidCredentials());
    if (account.banned) return next(errors.banned());

    services.accounts.touchLogin(account.id);
    const session = services.tokens.issueSession({ accountId: account.id, clientId, deviceId, authMethod });
    res.json(sessionResponse(account, clientId, session, deviceId));
  });

  router.get('/account/api/oauth/verify', authAny, (req, res) => {
    const a = req.auth;
    res.json({
      token: req.auth.token,
      session_id: a.sessionId,
      token_type: 'bearer',
      client_id: a.clientId,
      internal_client: true,
      client_service: 'fortnite',
      account_id: a.accountId,
      expires_in: Math.round((a.expiresAt - Date.now()) / 1000),
      expires_at: new Date(a.expiresAt).toISOString(),
      auth_method: a.authMethod,
      display_name: req.account ? req.account.displayName : undefined,
      app: 'fortnite',
      in_app_id: a.accountId,
      device_id: a.deviceId,
    });
  });

  // Launchers call this to get a one-time code they pass to the game with -AUTH_PASSWORD.
  router.get('/account/api/oauth/exchange', auth, (req, res) => {
    const code = services.tokens.issueExchangeCode(req.account.id, req.auth.clientId);
    res.json({
      expiresInSeconds: Math.round((code.expiresAt - Date.now()) / 1000),
      code: code.token,
      creatingClientId: req.auth.clientId,
    });
  });

  router.delete('/account/api/oauth/sessions/kill', authAny, (req, res) => {
    const killType = req.query.killType;
    if (req.account && (killType === 'OTHERS' || killType === 'OTHERS_ACCOUNT_CLIENT' || killType === 'OTHERS_ACCOUNT_CLIENT_SERVICE')) {
      services.tokens.revokeOtherSessions(req.account.id, req.auth.sessionId);
    } else if (req.account && killType === 'ALL_ACCOUNT_CLIENT') {
      services.tokens.revokeAllForAccount(req.account.id);
    }
    res.status(204).end();
  });

  router.delete('/account/api/oauth/sessions/kill/:token', (req, res) => {
    const token = req.params.token.replace(/^eg1~/, '');
    const found = services.tokens.find(token, ['access', 'client']);
    if (found && found.sessionId) services.tokens.revokeSession(found.sessionId);
    else if (found) services.tokens.revoke(token);
    res.status(204).end();
  });

  router.get('/account/api/public/account', authAny, (req, res) => {
    let ids = req.query.accountId || [];
    if (!Array.isArray(ids)) ids = [ids];
    const found = ids.slice(0, 100).map((id) => services.accounts.findById(id)).filter(Boolean);
    res.json(found.map(publicAccount));
  });

  router.get('/account/api/public/account/displayName/:displayName', authAny, (req, res, next) => {
    const account = services.accounts.findByDisplayName(req.params.displayName);
    if (!account) return next(errors.notFound());
    res.json(publicAccount(account));
  });

  router.get('/account/api/public/account/:accountId', authAny, (req, res, next) => {
    const account = services.accounts.findById(req.params.accountId);
    if (!account) return next(errors.notFound());
    const isSelf = req.account && req.account.id === account.id;
    res.json({
      id: account.id,
      displayName: account.displayName,
      name: account.displayName,
      email: isSelf ? account.email : undefined,
      failedLoginAttempts: 0,
      lastLogin: account.lastLogin || account.createdAt,
      numberOfDisplayNameChanges: 0,
      ageGroup: 'UNKNOWN',
      headless: false,
      country: 'US',
      lastName: 'Server',
      preferredLanguage: 'en',
      canUpdateDisplayName: false,
      tfaEnabled: false,
      emailVerified: true,
      minorVerified: false,
      minorExpected: false,
      minorStatus: 'UNKNOWN',
      cabinedMode: false,
      hasHashedEmail: false,
    });
  });

  router.get('/account/api/public/account/:accountId/externalAuths', authAny, (req, res) => res.json([]));
  router.get('/account/api/public/account/:accountId/deviceAuth', auth, (req, res) => res.json([]));
  router.get('/account/api/accounts/:accountId/metadata', auth, (req, res) => res.json({}));
  router.get('/account/api/epicdomains/ssodomains', (req, res) =>
    res.json(['unrealengine.com', 'unrealtournament.com', 'fortnite.com', 'epicgames.com']),
  );

  router.get('/persona/api/public/account/lookup', authAny, (req, res, next) => {
    const account = services.accounts.findByDisplayName(String(req.query.q || ''));
    if (!account) return next(errors.notFound());
    res.json(publicAccount(account));
  });

  // Friend search used by newer clients.
  router.get('/api/v1/search/:accountId', auth, (req, res) => {
    const prefix = String(req.query.prefix || '');
    if (!prefix) return res.json([]);
    const results = services.accounts
      .searchByPrefix(prefix)
      .filter((a) => a.id !== req.account.id)
      .map((a, i) => ({
        accountId: a.id,
        matches: [{ value: a.displayName, platform: 'epic' }],
        matchType: a.displayName.toLowerCase() === prefix.toLowerCase() ? 'exact' : 'prefix',
        epicMutuals: 0,
        sortPosition: i,
      }));
    res.json(results);
  });

  return router;
};
