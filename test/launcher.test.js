'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { start, CLIENT } = require('./helpers');
const core = require('../launcher/core');
const { createLauncher } = require('../launcher/index');

let t;
let tmp;
before(async () => {
  t = await start();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ogfn-launcher-'));
});
after(async () => {
  await t.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Makes a fake build folder with the game files the launcher looks for.
function fakeBuild(name, helpers = ['FortniteLauncher.exe', 'FortniteClient-Win64-Shipping_EAC.exe']) {
  const win64 = path.join(tmp, name, 'FortniteGame', 'Binaries', 'Win64');
  fs.mkdirSync(win64, { recursive: true });
  for (const file of [core.SHIPPING, ...helpers]) fs.writeFileSync(path.join(win64, file), '');
  return { root: path.join(tmp, name), win64 };
}

test('finds the game from the build folder, the Win64 folder or one level up', () => {
  const { root, win64 } = fakeBuild('14.60');
  assert.equal(core.findGame(root).win64, win64);
  assert.equal(core.findGame(win64).win64, win64);
  assert.equal(core.findGame(tmp).win64, win64);
  assert.equal(core.findGame(`"${root}"`).win64, win64);
  assert.equal(core.findGame(root).helpers.length, 2);
  assert.equal(core.findGame(path.join(tmp, 'nope')), null);
  assert.equal(core.findGame(''), null);
});

test('launch arguments', () => {
  assert.deepEqual(core.splitArgs('-log -foo="two words"  -x'), ['-log', '-foo=two words', '-x']);
  const args = core.buildArgs('abc123', '-log');
  assert.ok(args.includes('-AUTH_TYPE=exchangecode'));
  assert.ok(args.includes('-AUTH_PASSWORD=abc123'));
  assert.equal(args.at(-1), '-log');
  assert.equal(core.normalizeServerUrl('127.0.0.1:3551/'), 'http://127.0.0.1:3551');
  assert.equal(core.normalizeServerUrl(''), 'http://127.0.0.1:3551');
});

// Runs the launcher with a fake Windows layer that records what it would start.
async function startLauncher() {
  const started = { suspended: [], game: null, killed: [] };
  const platform = {
    isWindows: true,
    pickFolder: async () => 'C:\\picked',
    async startSuspended(exe, args) {
      started.suspended.push({ exe, args });
      return 1000 + started.suspended.length;
    },
    startGame(exe, args) {
      const child = new EventEmitter();
      child.pid = 4242;
      started.game = { exe, args, child };
      return child;
    },
    kill: (pid) => started.killed.push(pid),
  };
  const settings = new core.Settings(path.join(tmp, `settings-${Math.random()}.json`));
  const launcher = createLauncher({ settings, platform, logger: { log() {} } });
  const server = http.createServer(launcher.app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  launcher.setPort(server.address().port);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, body, headers = { 'x-launcher-token': launcher.token }) => {
    const res = await fetch(base + '/api/' + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { launcher, settings, started, call, base, close: () => new Promise((r) => server.close(r)) };
}

test('launcher API needs its token', async () => {
  const l = await startLauncher();
  try {
    assert.equal((await l.call('state', undefined, {})).status, 403);
    assert.equal((await l.call('state', undefined, { 'x-launcher-token': 'wrong' })).status, 403);
    assert.equal((await l.call('state')).status, 200);
    const page = await fetch(l.base + '/');
    assert.match(await page.text(), /OGFN Launcher/);
  } finally {
    await l.close();
  }
});

test('launch logs in, starts helpers paused, then starts the game', async () => {
  await t.register('Launchy');
  const { root, win64 } = fakeBuild('launch-build');
  const l = await startLauncher();
  try {
    const server = await l.call('server-status', { serverUrl: t.base });
    assert.equal(server.body.name, 'OGFN Server Emulator');

    const bad = await l.call('launch', { gamePath: root, serverUrl: t.base, login: 'Launchy', password: 'wrongpass1' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /incorrect/);
    assert.equal(l.started.game, null);

    const res = await l.call('launch', { gamePath: root, serverUrl: t.base, login: 'Launchy', password: 'password123', extraArgs: '-log' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(l.started.suspended.length, 2);
    assert.equal(l.started.game.exe, path.join(win64, core.SHIPPING));
    assert.ok(l.started.game.args.includes('-log'));

    // The code the game got really logs in.
    const code = l.started.game.args.find((a) => a.startsWith('-AUTH_PASSWORD=')).split('=')[1];
    const login = await t.request('POST', '/account/api/oauth/token', { headers: { authorization: CLIENT }, form: { grant_type: 'exchange_code', exchange_code: code } });
    assert.equal(login.body.displayName, 'Launchy');

    assert.equal((await l.call('state')).body.state.status, 'running');
    assert.equal((await l.call('launch', { gamePath: root, serverUrl: t.base, login: 'Launchy', password: 'password123' })).status, 409);

    // Game closes -> paused helpers are cleaned up.
    l.started.game.child.emit('exit', 0);
    assert.deepEqual(l.started.killed.sort(), [1001, 1002, 4242]);
    assert.equal((await l.call('state')).body.state.status, 'idle');

    // Settings are remembered, the password is not.
    const saved = JSON.parse(fs.readFileSync(l.settings.file, 'utf8'));
    assert.equal(saved.login, 'Launchy');
    assert.equal(saved.password, undefined);
  } finally {
    await l.close();
  }
});

test('launch explains a missing folder and an offline server', async () => {
  const l = await startLauncher();
  try {
    const noGame = await l.call('launch', { gamePath: path.join(tmp, 'missing'), serverUrl: t.base, login: 'x', password: 'y' });
    assert.match(noGame.body.error, /build folder/);
    const offline = await l.call('server-status', { serverUrl: 'http://127.0.0.1:1' });
    assert.equal(offline.status, 502);
    assert.equal((await l.call('pick-folder', {})).body.path, 'C:\\picked');
  } finally {
    await l.close();
  }
});
