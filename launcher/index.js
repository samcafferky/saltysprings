'use strict';

// OGFN Launcher: a small local web page for picking your build folder and
// starting the game against your OGFN server. Run with `npm run launcher`.

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const core = require('./core');

function createLauncher({ settings, platform, logger = console }) {
  const token = crypto.randomBytes(24).toString('hex');
  const state = { status: 'idle', message: '', gamePid: null, helperPids: [] };
  let port = 0;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  // Only this computer's browser, holding the token from the start-up URL,
  // can use the launcher. Stops other websites from poking it.
  app.use('/api', (req, res, next) => {
    const hostOk = req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
    const given = Buffer.from(String(req.headers['x-launcher-token'] || ''));
    const tokenOk = given.length === token.length && crypto.timingSafeEqual(given, Buffer.from(token));
    if (!hostOk || !tokenOk) return res.status(403).json({ error: 'Not allowed' });
    next();
  });

  const fail = (res, err, status = 400) => res.status(status).json({ error: err.message || String(err) });

  function stopGame(message = 'Game closed.') {
    for (const pid of state.helperPids) platform.kill(pid);
    if (state.gamePid) platform.kill(state.gamePid);
    Object.assign(state, { status: 'idle', message, gamePid: null, helperPids: [] });
  }

  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'ui.html')));

  app.get('/api/state', (req, res) => {
    const game = core.findGame(settings.values.gamePath);
    res.json({ settings: settings.values, game, state, windows: platform.isWindows });
  });

  app.post('/api/settings', (req, res) => res.json(settings.save(req.body || {})));

  app.post('/api/check-folder', (req, res) => {
    const game = core.findGame((req.body || {}).path);
    if (!game) return fail(res, new Error(`Couldn't find ${core.SHIPPING} in that folder. Pick the folder that has "FortniteGame" inside it.`), 404);
    res.json(game);
  });

  app.post('/api/pick-folder', async (req, res) => {
    try {
      res.json({ path: await platform.pickFolder() });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/server-status', async (req, res) => {
    try {
      res.json(await core.serverInfo((req.body || {}).serverUrl));
    } catch (err) {
      fail(res, new Error(`Can't reach the server: ${err.message}. Is it running?`), 502);
    }
  });

  app.post('/api/launch', async (req, res) => {
    const { gamePath, serverUrl, login, password, extraArgs } = req.body || {};
    if (state.status !== 'idle') return fail(res, new Error('The game is already running.'), 409);
    if (!platform.isWindows) return fail(res, new Error('Fortnite only runs on Windows.'));
    const game = core.findGame(gamePath);
    if (!game) return fail(res, new Error('Pick your Fortnite build folder first.'));
    if (!login || !password) return fail(res, new Error('Enter your email (or display name) and password.'));

    settings.save({ gamePath, serverUrl, login, extraArgs });
    state.status = 'starting';
    state.message = 'Logging in...';
    try {
      const { code, displayName } = await core.getExchangeCode(serverUrl, login, password);
      const args = core.buildArgs(code, extraArgs);

      state.message = 'Starting Fortnite...';
      for (const helper of game.helpers) state.helperPids.push(await platform.startSuspended(helper, args, game.win64));
      const child = platform.startGame(game.exe, args, game.win64);
      state.gamePid = child.pid;
      state.status = 'running';
      state.message = `Fortnite is running as ${displayName}.`;
      logger.log(`[launcher] started ${game.exe} (pid ${child.pid}) as ${displayName}`);

      child.on('exit', (exitCode) => {
        logger.log(`[launcher] game exited (code ${exitCode})`);
        if (state.gamePid === child.pid) stopGame(exitCode ? `Game closed (exit code ${exitCode}).` : 'Game closed.');
      });
      child.on('error', (err) => {
        if (state.gamePid === child.pid) stopGame(`Game failed to start: ${err.message}`);
      });
      res.json({ ok: true, displayName });
    } catch (err) {
      stopGame(`Launch failed: ${err.message}`);
      fail(res, err);
    }
  });

  app.post('/api/stop', (req, res) => {
    stopGame();
    res.json({ ok: true });
  });

  return {
    app,
    token,
    state,
    stopGame,
    setPort(p) {
      port = p;
    },
  };
}

async function main() {
  const { loadConfig } = require('../src/config');
  const platform = require('./windows');
  const config = loadConfig();
  const settings = new core.Settings(path.join(config.dataDir, 'launcher.json'));
  const launcher = createLauncher({ settings, platform });

  const server = http.createServer(launcher.app);
  await new Promise((resolve) => server.listen(Number(process.env.LAUNCHER_PORT) || 0, '127.0.0.1', resolve));
  launcher.setPort(server.address().port);

  const url = `http://127.0.0.1:${server.address().port}/?t=${launcher.token}`;
  console.log('[launcher] OGFN Launcher is open in your browser.');
  console.log(`[launcher] If it didn't open, go to: ${url}`);
  console.log('[launcher] Keep this window open while you play. Close it to quit.');
  platform.openBrowser(url);

  const quit = () => {
    launcher.stopGame();
    process.exit(0);
  };
  // SIGHUP is what Windows sends when the console window is closed.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, quit);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[launcher] failed to start:', err);
    process.exit(1);
  });
}

module.exports = { createLauncher };
