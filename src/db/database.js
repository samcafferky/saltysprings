'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_login    TEXT,
  banned        INTEGER NOT NULL DEFAULT 0,
  is_admin      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash  TEXT PRIMARY KEY,
  type        TEXT NOT NULL,          -- access | refresh | exchange | client
  account_id  TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL,
  device_id   TEXT,
  session_id  TEXT,
  auth_method TEXT,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_account ON tokens(account_id);
CREATE INDEX IF NOT EXISTS tokens_expires ON tokens(expires_at);

CREATE TABLE IF NOT EXISTS profiles (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  data       TEXT NOT NULL,
  PRIMARY KEY (account_id, profile_id)
);

CREATE TABLE IF NOT EXISTS friends (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  friend_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, friend_id)
);

CREATE TABLE IF NOT EXISTS friend_requests (
  from_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS cloudstorage (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  data       BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, filename)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

// Runs fn inside a transaction; rolls back if it throws.
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

module.exports = { openDatabase, transaction, getSetting, setSetting };
