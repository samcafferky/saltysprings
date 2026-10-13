'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');
const { getVersionInfo } = require('../src/utils/version');

let t;
before(async () => (t = await start()));
after(() => t.close());

test('version parsing', () => {
  assert.equal(getVersionInfo('Fortnite/++Fortnite+Release-4.5-CL-4166199 Windows/10').season, 4);
  assert.equal(getVersionInfo('Fortnite/++Fortnite+Release-1.8-CL-3724489 Windows/10').season, 1);
  assert.equal(getVersionInfo('Fortnite/++Fortnite+Release-1.11-CL-3807424 Windows/10').season, 2);
  assert.equal(getVersionInfo('Fortnite/++Fortnite+Release-10.40-CL-9380822 Windows/10').lobby, 'LobbySeason10');
  assert.equal(getVersionInfo('', 3).season, 3);
});

test('timeline and content follow the client season', async () => {
  const u = await t.user('GameA');
  const ua = { 'user-agent': 'Fortnite/++Fortnite+Release-10.40-CL-9380822 Windows/10' };
  const timeline = await t.request('GET', '/fortnite/api/calendar/v1/timeline', { token: u.token, headers: ua });
  const state = timeline.body.channels['client-events'].states[0];
  assert.equal(state.state.seasonNumber, 10);
  assert.ok(state.activeEvents.some((e) => e.eventType === 'EventFlag.LobbySeason10'));

  const content = await t.request('GET', '/content/api/pages/fortnite-game', { headers: ua });
  assert.equal(content.body.dynamicbackgrounds.backgrounds.backgrounds[0].stage, 'seasonx');
  assert.equal(content.body.battleroyalenews.news.messages[0].title, 'Welcome!');
});

test('system cloudstorage lists hotfix files with the xmpp port filled in', async () => {
  const u = await t.user('GameB');
  const list = await t.request('GET', '/fortnite/api/cloudstorage/system', { token: u.token });
  const names = list.body.map((f) => f.filename);
  assert.ok(names.includes('DefaultEngine.ini'));
  const engine = await t.request('GET', '/fortnite/api/cloudstorage/system/DefaultEngine.ini', { token: u.token });
  assert.match(engine.text, new RegExp(`ServerPort=${t.server.xmppPort}`));
  assert.ok(!engine.text.includes('{{'));
});

test('user cloudstorage saves and returns settings files', async () => {
  const u = await t.user('GameC');
  const bytes = Buffer.from([0, 1, 2, 3, 250, 251]);
  const put = await fetch(`${t.base}/fortnite/api/cloudstorage/user/${u.accountId}/ClientSettings.Sav`, {
    method: 'PUT',
    headers: { authorization: `bearer ${u.token}`, 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  assert.equal(put.status, 204);
  const get = await fetch(`${t.base}/fortnite/api/cloudstorage/user/${u.accountId}/ClientSettings.Sav`, { headers: { authorization: `bearer ${u.token}` } });
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
  const list = await t.request('GET', `/fortnite/api/cloudstorage/user/${u.accountId}`, { token: u.token });
  assert.equal(list.body[0].length, bytes.length);

  const other = await t.user('GameD');
  assert.equal((await t.request('GET', `/fortnite/api/cloudstorage/user/${u.accountId}/ClientSettings.Sav`, { token: other.token })).status, 403);
});

test('common stubs answer like Epic does', async () => {
  const u = await t.user('GameE');
  assert.equal((await t.request('GET', '/fortnite/api/v2/versioncheck/Windows?version=x')).body.type, 'NO_UPDATE');
  assert.equal((await t.request('GET', '/waitingroom/api/waitingroom')).status, 204);
  assert.equal((await t.request('POST', `/fortnite/api/game/v2/tryPlayOnPlatform/account/${u.accountId}`, { token: u.token })).text, 'true');
  assert.deepEqual((await t.request('GET', '/fortnite/api/storefront/v2/keychain', { token: u.token })).body, []);
  const missing = await t.request('GET', '/does/not/exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('x-epic-error-name'), 'errors.com.epicgames.common.not_found');
});

test('registration is rate limited', async () => {
  const s = await start({ server: { port: 0, host: '127.0.0.1', publicHost: '127.0.0.1', rateLimits: { loginPerMinute: 100, registerPerMinute: 2 } } });
  try {
    const body = (i) => ({ body: { email: `r${i}@test.com`, displayName: `Rate${i}`, password: 'password123' } });
    assert.equal((await s.request('POST', '/api/register', body(1))).status, 201);
    assert.equal((await s.request('POST', '/api/register', body(2))).status, 201);
    assert.equal((await s.request('POST', '/api/register', body(3))).status, 429);
  } finally {
    await s.close();
  }
});

test('cosmetics list parsing handles API and plain formats', () => {
  const { parseCosmetics } = require('../src/services/cosmetics');
  const api = {
    status: 200,
    data: [
      { id: 'CID_028_Athena_Commando_F', type: { backendValue: 'AthenaCharacter' }, variants: [{ channel: 'Material', options: [{ tag: 'Mat1' }, { tag: 'Mat2' }] }] },
      { id: 'broken' },
    ],
  };
  assert.deepEqual(parseCosmetics(api), [
    { templateId: 'AthenaCharacter:cid_028_athena_commando_f', variants: [{ channel: 'Material', active: 'Mat1', owned: ['Mat1', 'Mat2'] }] },
  ]);
  assert.equal(parseCosmetics({ data: { br: api.data } }).length, 1);
  assert.deepEqual(parseCosmetics(['AthenaDance:EID_Floss']), [{ templateId: 'AthenaDance:eid_floss', variants: [] }]);
});
