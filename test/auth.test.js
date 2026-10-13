'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, CLIENT } = require('./helpers');

let t;
before(async () => (t = await start()));
after(() => t.close());

test('register rejects duplicates and bad input', async () => {
  await t.register('Alpha');
  const dup = await t.request('POST', '/api/register', { body: { email: 'other@test.com', displayName: 'alpha', password: 'password123' } });
  assert.equal(dup.status, 409);
  const short = await t.request('POST', '/api/register', { body: { email: 'x@test.com', displayName: 'Xyz', password: 'short' } });
  assert.equal(short.status, 400);
});

test('password grant works with display name or email', async () => {
  await t.register('Bravo');
  const byName = await t.login('Bravo');
  const byEmail = await t.login('bravo@test.com');
  assert.equal(byName.accountId, byEmail.accountId);
  assert.ok(byName.raw.refresh_token.startsWith('eg1~'));

  const bad = await t.request('POST', '/account/api/oauth/token', {
    headers: { authorization: CLIENT },
    form: { grant_type: 'password', username: 'Bravo', password: 'wrongpass1' },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errorCode, 'errors.com.epicgames.account.invalid_account_credentials');
});

test('token request without client auth is rejected', async () => {
  const res = await t.request('POST', '/account/api/oauth/token', { form: { grant_type: 'client_credentials' } });
  assert.equal(res.status, 400);
});

test('exchange codes are single use', async () => {
  const { token } = await t.user('Charlie');
  const ex = await t.request('GET', '/account/api/oauth/exchange', { token });
  assert.equal(ex.status, 200);
  const grant = { headers: { authorization: CLIENT }, form: { grant_type: 'exchange_code', exchange_code: ex.body.code } };
  assert.equal((await t.request('POST', '/account/api/oauth/token', grant)).status, 200);
  assert.equal((await t.request('POST', '/account/api/oauth/token', grant)).status, 400);
});

test('old builds that send the one-time code as a password can log in', async () => {
  await t.register('Oldie');
  const ex = await t.request('POST', '/api/launcher/exchange', { body: { login: 'Oldie', password: 'password123' } });
  const grant = { headers: { authorization: CLIENT }, form: { grant_type: 'password', username: 'unused', password: ex.body.code } };
  const res = await t.request('POST', '/account/api/oauth/token', grant);
  assert.equal(res.status, 200);
  assert.equal(res.body.displayName, 'Oldie');
  // Still single use.
  assert.equal((await t.request('POST', '/account/api/oauth/token', grant)).status, 400);
});

test('launcher exchange endpoint gives a working code', async () => {
  await t.register('Delta');
  const ex = await t.request('POST', '/api/launcher/exchange', { body: { login: 'Delta', password: 'password123' } });
  assert.equal(ex.status, 200);
  const res = await t.request('POST', '/account/api/oauth/token', {
    headers: { authorization: CLIENT },
    form: { grant_type: 'exchange_code', exchange_code: ex.body.code },
  });
  assert.equal(res.body.displayName, 'Delta');
});

test('refresh token rotates the session', async () => {
  const { raw, token } = await t.user('Echo');
  const res = await t.request('POST', '/account/api/oauth/token', {
    headers: { authorization: CLIENT },
    form: { grant_type: 'refresh_token', refresh_token: raw.refresh_token },
  });
  assert.equal(res.status, 200);
  // The old access token belonged to the old session and is gone.
  assert.equal((await t.request('GET', '/account/api/oauth/verify', { token })).status, 401);
  const fresh = res.body.access_token.replace('eg1~', '');
  const verify = await t.request('GET', '/account/api/oauth/verify', { token: fresh });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.display_name, 'Echo');
});

test('killing a session revokes the token', async () => {
  const { token } = await t.user('Foxtrot');
  assert.equal((await t.request('DELETE', `/account/api/oauth/sessions/kill/eg1~${token}`)).status, 204);
  assert.equal((await t.request('GET', '/account/api/oauth/verify', { token })).status, 401);
});

test('account lookups', async () => {
  const { token, accountId } = await t.user('Golf');
  const self = await t.request('GET', `/account/api/public/account/${accountId}`, { token });
  assert.equal(self.body.email, 'golf@test.com');
  const bulk = await t.request('GET', `/account/api/public/account?accountId=${accountId}&accountId=missing`, { token });
  assert.deepEqual(bulk.body.map((a) => a.displayName), ['Golf']);
  const byName = await t.request('GET', '/account/api/public/account/displayName/golf', { token });
  assert.equal(byName.body.id, accountId);
});

test('banned accounts lose their sessions and cannot log in', async () => {
  const { token, accountId } = await t.user('Hotel');
  const admin = { headers: { authorization: 'Bearer test-admin-key' } };
  assert.equal((await t.request('POST', `/admin/api/accounts/${accountId}/ban`, admin)).status, 204);
  assert.equal((await t.request('GET', '/account/api/oauth/verify', { token })).status, 401);
  const res = await t.request('POST', '/account/api/oauth/token', {
    headers: { authorization: CLIENT },
    form: { grant_type: 'password', username: 'Hotel', password: 'password123' },
  });
  assert.equal(res.body.errorCode, 'errors.com.epicgames.account.account_not_active');
});

test('admin API needs the key', async () => {
  assert.equal((await t.request('GET', '/admin/api/accounts')).status, 403);
  assert.equal((await t.request('GET', '/admin/api/accounts', { headers: { authorization: 'Bearer wrong' } })).status, 403);
  assert.equal((await t.request('GET', '/admin/api/accounts', { headers: { authorization: 'Bearer test-admin-key' } })).status, 200);
});

test('invite code is enforced when set', async () => {
  const s = await start({ registration: { enabled: true, inviteCode: 'friends-only' } });
  try {
    const no = await s.request('POST', '/api/register', { body: { email: 'i@test.com', displayName: 'India', password: 'password123' } });
    assert.equal(no.status, 403);
    const yes = await s.request('POST', '/api/register', { body: { email: 'i@test.com', displayName: 'India', password: 'password123', inviteCode: 'friends-only' } });
    assert.equal(yes.status, 201);
  } finally {
    await s.close();
  }
});
