'use strict';

const { newToken, sha256, hexId } = require('../utils/ids');

const HOUR = 3600 * 1000;

// Tokens are random strings. Only their SHA-256 hash is stored, so a leaked
// database can't be used to log in as someone.
class TokenService {
  constructor(db, authConfig) {
    this.db = db;
    this.config = authConfig;
  }

  issue({ type, accountId = null, clientId, deviceId = null, sessionId = null, authMethod = null, ttlMs }) {
    const token = newToken();
    const now = Date.now();
    const expiresAt = now + ttlMs;
    this.db
      .prepare(
        `INSERT INTO tokens (token_hash, type, account_id, client_id, device_id, session_id, auth_method, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sha256(token), type, accountId, clientId, deviceId, sessionId, authMethod, expiresAt, now);
    return { token, expiresAt };
  }

  // Creates the access + refresh pair the client gets after logging in.
  issueSession({ accountId, clientId, deviceId, authMethod }) {
    const sessionId = hexId();
    const access = this.issue({
      type: 'access',
      accountId,
      clientId,
      deviceId,
      sessionId,
      authMethod,
      ttlMs: this.config.accessTokenHours * HOUR,
    });
    const refresh = this.issue({
      type: 'refresh',
      accountId,
      clientId,
      deviceId,
      sessionId,
      authMethod,
      ttlMs: this.config.refreshTokenHours * HOUR,
    });
    return { access, refresh, sessionId };
  }

  issueClient(clientId) {
    return this.issue({ type: 'client', clientId, ttlMs: 4 * HOUR });
  }

  issueExchangeCode(accountId, clientId) {
    return this.issue({ type: 'exchange', accountId, clientId, ttlMs: this.config.exchangeCodeMinutes * 60 * 1000 });
  }

  find(token, types) {
    if (!token) return null;
    const row = this.db.prepare('SELECT * FROM tokens WHERE token_hash = ?').get(sha256(String(token)));
    if (!row || !types.includes(row.type)) return null;
    if (row.expires_at <= Date.now()) {
      this.revoke(token);
      return null;
    }
    return {
      type: row.type,
      accountId: row.account_id,
      clientId: row.client_id,
      deviceId: row.device_id,
      sessionId: row.session_id,
      authMethod: row.auth_method,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  // Finds a single-use token and deletes it in the same step.
  consume(token, type) {
    const found = this.find(token, [type]);
    if (found) this.revoke(token);
    return found;
  }

  revoke(token) {
    this.db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(sha256(String(token)));
  }

  revokeSession(sessionId) {
    this.db.prepare('DELETE FROM tokens WHERE session_id = ?').run(sessionId);
  }

  revokeOtherSessions(accountId, keepSessionId) {
    this.db.prepare("DELETE FROM tokens WHERE account_id = ? AND type IN ('access','refresh') AND session_id != ?").run(accountId, keepSessionId);
  }

  revokeAllForAccount(accountId) {
    this.db.prepare('DELETE FROM tokens WHERE account_id = ?').run(accountId);
  }

  purgeExpired() {
    return this.db.prepare('DELETE FROM tokens WHERE expires_at <= ?').run(Date.now()).changes;
  }
}

module.exports = { TokenService };
