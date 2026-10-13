'use strict';

const { errors } = require('../utils/errors');

// Pulls the token out of "Authorization: bearer eg1~<token>".
function readBearer(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^bearer\s+(.+)$/i);
  if (!match) return null;
  return match[1].trim().replace(/^eg1~/, '');
}

// options.allowClient: also accept client_credentials tokens (used by game servers).
function requireAuth(services, { allowClient = false } = {}) {
  const types = allowClient ? ['access', 'client'] : ['access'];
  return (req, res, next) => {
    const token = readBearer(req);
    if (!token) return next(errors.missingAuth());
    const found = services.tokens.find(token, types);
    if (!found) return next(errors.invalidToken(token));

    if (found.accountId) {
      const account = services.accounts.findById(found.accountId);
      if (!account) return next(errors.invalidToken(token));
      if (account.banned) return next(errors.banned());
      req.account = account;
    }
    req.auth = { ...found, token };
    next();
  };
}

// Blocks a player from reading or changing another player's private data.
function requireSelf(param = 'accountId') {
  return (req, res, next) => {
    if (!req.account || req.account.id !== req.params[param]) {
      return next(errors.forbidden(`You can't access account ${req.params[param]}'s data`));
    }
    next();
  };
}

module.exports = { requireAuth, requireSelf, readBearer };
