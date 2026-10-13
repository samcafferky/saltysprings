'use strict';

const crypto = require('node:crypto');
const { hexId } = require('../utils/ids');
const { getSetting, setSetting } = require('../db/database');

const TICKET_TTL_MS = 2 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;

// Matchmaking tickets are signed so the matchmaker websocket can trust them.
class MatchmakingService {
  constructor(db, config) {
    this.config = config;
    this.sessions = new Map();
    let secret = getSetting(db, 'matchmaking_secret');
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      setSetting(db, 'matchmaking_secret', secret);
    }
    this.secret = secret;
  }

  sign(payload) {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  // bucketId looks like "4166199:0:NAE:playlist_defaultsolo" (build:hotfix:region:playlist).
  createTicket(accountId, query) {
    const [buildId = '0', , region = 'NAE', playlist = 'playlist_defaultsolo'] = String(query.bucketId || '').split(':');
    const data = {
      accountId,
      buildId,
      region: region.toUpperCase(),
      playlist: playlist.toLowerCase(),
      customKey: query['player.option.customKey'] || null,
      exp: Date.now() + TICKET_TTL_MS,
    };
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    return { payload, signature: this.sign(payload) };
  }

  verifyTicket(payload, signature) {
    if (!payload || !signature) return null;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(String(signature));
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return data.exp > Date.now() ? data : null;
    } catch {
      return null;
    }
  }

  // Picks a game server for the ticket. Servers with a customKey only take
  // players who entered that key, which makes them private.
  findServer(ticket) {
    return (this.config.matchmaking.gameServers || []).find((s) => {
      if ((s.customKey || null) !== (ticket.customKey || null)) return false;
      const regionOk = !s.regions || !s.regions.length || s.regions.map((r) => r.toUpperCase()).includes(ticket.region);
      const playlistOk = !s.playlists || !s.playlists.length || s.playlists.map((p) => p.toLowerCase()).includes(ticket.playlist);
      return regionOk && playlistOk;
    });
  }

  createSession(ticket, server) {
    this.purge();
    const sessionId = hexId();
    this.sessions.set(sessionId, { ...ticket, server, expires: Date.now() + SESSION_TTL_MS });
    return sessionId;
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.expires <= Date.now()) return null;
    return session;
  }

  purge() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (s.expires <= now) this.sessions.delete(id);
  }
}

module.exports = { MatchmakingService };
