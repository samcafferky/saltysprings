'use strict';

const { loadConfig } = require('../src/config');
const WebSocket = require('ws');
const { startServer } = require('../src/server');

const quiet = { log() {}, warn() {}, error: console.error };
const CLIENT = `basic ${Buffer.from('ec684b8c687f479fadea3cb2ad83f5c6:secret').toString('base64')}`;
const UA = 'Fortnite/++Fortnite+Release-7.40-CL-5046157 Windows/10.0.17134.1.768.64bit';

async function start(overrides = {}) {
  const config = loadConfig({
    server: { port: 0, host: '127.0.0.1', publicHost: '127.0.0.1', rateLimits: { loginPerMinute: 1000, registerPerMinute: 1000 } },
    xmpp: { port: 0 },
    database: { path: ':memory:' },
    admin: { apiKey: 'test-admin-key' },
    registration: { enabled: true, inviteCode: '' },
    matchmaking: { gameServers: [] },
    ...overrides,
  });
  const server = await startServer(config, { logger: quiet });
  const base = `http://127.0.0.1:${server.port}`;

  async function request(method, path, { body, token, form, headers = {} } = {}) {
    const h = { 'user-agent': UA, ...headers };
    if (token) h.authorization = `bearer eg1~${token}`;
    let payload;
    if (form) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + path, { method, headers: h, body: payload });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  async function register(displayName, password = 'password123') {
    const res = await request('POST', '/api/register', { body: { email: `${displayName.toLowerCase()}@test.com`, displayName, password } });
    if (res.status !== 201) throw new Error(`register failed: ${res.text}`);
    return res.body.accountId;
  }

  async function login(username, password = 'password123') {
    const res = await request('POST', '/account/api/oauth/token', {
      headers: { authorization: CLIENT },
      form: { grant_type: 'password', username, password },
    });
    if (res.status !== 200) throw new Error(`login failed: ${res.text}`);
    return { token: res.body.access_token.replace('eg1~', ''), accountId: res.body.account_id, raw: res.body };
  }

  async function user(name) {
    await register(name);
    return login(name);
  }

  return { server, config, base, request, register, login, user, close: () => server.close() };
}

// Connects to XMPP and logs in. Collects every message it receives.
async function xmppLogin(t, u) {
  const ws = new WebSocket(`ws://127.0.0.1:${t.server.xmppPort}`, 'xmpp');
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const msg = d.toString();
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const waitFor = (pattern, timeout = 2000) =>
    new Promise((resolve, reject) => {
      const match = (m) => pattern.test(m);
      const found = inbox.find(match);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}`)), timeout);
      waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  await new Promise((r) => ws.once('open', r));

  ws.send('<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="prod.ol.epicgames.com" version="1.0"/>');
  await waitFor(/<mechanism>PLAIN<\/mechanism>/);
  const plain = Buffer.from(`\0${u.accountId}\0${u.token}`).toString('base64');
  ws.send(`<auth mechanism="PLAIN" xmlns="urn:ietf:params:xml:ns:xmpp-sasl">${plain}</auth>`);
  await waitFor(/<success/);
  ws.send('<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="prod.ol.epicgames.com" version="1.0"/>');
  ws.send('<iq id="_xmpp_bind1" type="set"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><resource>V2:Fortnite:WIN::TEST</resource></bind></iq>');
  await waitFor(/<jid>/);
  ws.send('<iq id="_xmpp_session1" type="set"><session xmlns="urn:ietf:params:xml:ns:xmpp-session"/></iq>');
  await waitFor(/id="_xmpp_session1"/);
  return { ws, inbox, waitFor };
}

module.exports = { start, xmppLogin, CLIENT, UA };
