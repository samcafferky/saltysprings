'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    out[key] = isObject(value) && isObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Load order: config.json -> config.local.json -> environment variables -> overrides.
function loadConfig(overrides = {}) {
  let config = deepMerge(readJson(path.join(ROOT, 'config.json')), readJson(path.join(ROOT, 'config.local.json')));

  const env = process.env;
  const fromEnv = {};
  if (env.PORT) fromEnv.server = { port: Number(env.PORT) };
  if (env.PUBLIC_HOST) fromEnv.server = { ...fromEnv.server, publicHost: env.PUBLIC_HOST };
  if (env.XMPP_PORT) fromEnv.xmpp = { port: Number(env.XMPP_PORT) };
  if (env.DB_PATH) fromEnv.database = { path: env.DB_PATH };
  if (env.DATA_DIR) fromEnv.dataDir = env.DATA_DIR;
  if (env.ADMIN_KEY) fromEnv.admin = { apiKey: env.ADMIN_KEY };
  if (env.INVITE_CODE) fromEnv.registration = { inviteCode: env.INVITE_CODE };
  config = deepMerge(config, fromEnv);

  config = deepMerge(config, overrides);
  config.root = ROOT;
  config.dataDir = path.resolve(ROOT, config.dataDir || 'data');
  return config;
}

module.exports = { loadConfig, deepMerge, ROOT };
