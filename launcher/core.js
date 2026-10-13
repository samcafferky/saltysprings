'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SHIPPING = 'FortniteClient-Win64-Shipping.exe';
// Old builds quit if these aren't running, so they get started (paused) too.
const HELPERS = ['FortniteLauncher.exe', 'FortniteClient-Win64-Shipping_EAC.exe', 'FortniteClient-Win64-Shipping_BE.exe'];

const BASE_ARGS = [
  '-epicapp=Fortnite',
  '-epicenv=Prod',
  '-epiclocale=en-us',
  '-epicportal',
  '-skippatchcheck',
  '-nobe',
  '-fromfl=eac',
  '-fltoken=3db3ba5dcbd2e16703f3978d',
];

const exists = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

// Finds the game in a folder. Accepts the build folder itself, the Win64
// folder, or a folder one level above the build (common after unzipping).
function findGame(folder) {
  if (!folder || typeof folder !== 'string') return null;
  const root = path.resolve(folder.trim().replace(/^"|"$/g, ''));
  const candidates = [path.join(root, 'FortniteGame', 'Binaries', 'Win64'), root];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(root, entry.name, 'FortniteGame', 'Binaries', 'Win64'));
    }
  } catch {
    return null;
  }

  const win64 = candidates.find((dir) => exists(path.join(dir, SHIPPING)));
  if (!win64) return null;
  return {
    win64,
    exe: path.join(win64, SHIPPING),
    helpers: HELPERS.map((name) => path.join(win64, name)).filter(exists),
    buildRoot: path.resolve(win64, '..', '..', '..'),
  };
}

// Splits "-a -b=\"two words\"" into ['-a', '-b=two words'].
function splitArgs(text) {
  return (String(text || '').match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((a) => a.replace(/"/g, ''));
}

function buildArgs(exchangeCode, extraArgs = '') {
  return [...BASE_ARGS, '-AUTH_LOGIN=unused', `-AUTH_PASSWORD=${exchangeCode}`, '-AUTH_TYPE=exchangecode', ...splitArgs(extraArgs)];
}

function normalizeServerUrl(url) {
  let value = String(url || '').trim().replace(/\/+$/, '');
  if (!value) value = 'http://127.0.0.1:3551';
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Server address must start with http:// or https://');
  return parsed.origin;
}

async function getJson(url, options) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.errorMessage || `Server answered with HTTP ${res.status}`);
  return data;
}

async function serverInfo(serverUrl) {
  return getJson(`${normalizeServerUrl(serverUrl)}/api/info`);
}

// Trades email/password for a one-time code the game logs in with.
async function getExchangeCode(serverUrl, login, password) {
  return getJson(`${normalizeServerUrl(serverUrl)}/api/launcher/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password }),
  });
}

class Settings {
  constructor(file) {
    this.file = file;
    this.values = { gamePath: '', serverUrl: 'http://127.0.0.1:3551', login: '', extraArgs: '' };
    try {
      Object.assign(this.values, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // First run: keep defaults.
    }
  }

  // The password is never saved.
  save(update) {
    for (const key of ['gamePath', 'serverUrl', 'login', 'extraArgs']) {
      if (typeof update[key] === 'string') this.values[key] = update[key];
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
    return this.values;
  }
}

module.exports = { findGame, splitArgs, buildArgs, normalizeServerUrl, serverInfo, getExchangeCode, Settings, SHIPPING, HELPERS };
