'use strict';

const { newAccountId } = require('../utils/ids');
const { hashPassword, verifyPassword } = require('../utils/password');
const { EpicError } = require('../utils/errors');

const NAME_RE = /^[A-Za-z0-9 _.\-]{3,16}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function rowToAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    lastLogin: row.last_login,
    banned: Boolean(row.banned),
    isAdmin: Boolean(row.is_admin),
  };
}

class AccountService {
  constructor(db) {
    this.db = db;
  }

  create({ email, displayName, password }) {
    email = String(email || '').trim();
    displayName = String(displayName || '').trim();
    password = String(password || '');

    if (!EMAIL_RE.test(email)) throw new EpicError('errors.com.epicgames.account.invalid_email', 'Please enter a valid e-mail address.', 18001);
    if (!NAME_RE.test(displayName)) {
      throw new EpicError(
        'errors.com.epicgames.account.invalid_display_name',
        'Display names must be 3-16 characters: letters, numbers, spaces, _ . or -',
        18002,
      );
    }
    if (password.length < 8 || password.length > 128) {
      throw new EpicError('errors.com.epicgames.account.invalid_password', 'Passwords must be 8-128 characters long.', 18003);
    }
    if (this.findByEmail(email)) throw new EpicError('errors.com.epicgames.account.email_taken', 'That e-mail is already in use.', 18004, 409);
    if (this.findByDisplayName(displayName)) {
      throw new EpicError('errors.com.epicgames.account.display_name_taken', 'That display name is already taken.', 18005, 409);
    }

    const id = newAccountId();
    this.db
      .prepare('INSERT INTO accounts (id, display_name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, displayName, email, hashPassword(password), new Date().toISOString());
    return this.findById(id);
  }

  findById(id) {
    return rowToAccount(this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(String(id)));
  }

  findByEmail(email) {
    return rowToAccount(this.db.prepare('SELECT * FROM accounts WHERE email = ?').get(String(email)));
  }

  findByDisplayName(name) {
    return rowToAccount(this.db.prepare('SELECT * FROM accounts WHERE display_name = ?').get(String(name)));
  }

  // Accepts either an e-mail or a display name, like the old Epic login did.
  findByLogin(login) {
    return this.findByEmail(login) || this.findByDisplayName(login);
  }

  searchByPrefix(prefix, limit = 10) {
    const escaped = String(prefix).replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.db
      .prepare("SELECT * FROM accounts WHERE display_name LIKE ? ESCAPE '\\' ORDER BY display_name LIMIT ?")
      .all(`${escaped}%`, limit)
      .map(rowToAccount);
  }

  list() {
    return this.db.prepare('SELECT * FROM accounts ORDER BY created_at').all().map(rowToAccount);
  }

  checkCredentials(login, password) {
    const account = this.findByLogin(String(login || '').trim());
    if (!account || !verifyPassword(String(password || ''), account.passwordHash)) return null;
    return account;
  }

  touchLogin(id) {
    this.db.prepare('UPDATE accounts SET last_login = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  setBanned(id, banned) {
    return this.db.prepare('UPDATE accounts SET banned = ? WHERE id = ?').run(banned ? 1 : 0, id).changes > 0;
  }

  setAdmin(id, isAdmin) {
    return this.db.prepare('UPDATE accounts SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id).changes > 0;
  }

  setPassword(id, password) {
    if (String(password).length < 8) throw new EpicError('errors.com.epicgames.account.invalid_password', 'Passwords must be at least 8 characters long.', 18003);
    return this.db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(hashPassword(password), id).changes > 0;
  }

  delete(id) {
    return this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes > 0;
  }
}

module.exports = { AccountService };
