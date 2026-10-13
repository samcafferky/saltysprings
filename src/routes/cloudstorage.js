'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { requireAuth, requireSelf } = require('../middleware/auth');
const { errors } = require('../utils/errors');

const MAX_USER_FILE = 5 * 1024 * 1024;
const MAX_USER_FILES = 20;
const FILE_NAME_RE = /^[A-Za-z0-9_.\-]{1,64}$/;

function fileEntry(filename, data, uploaded, uniqueFilename = filename) {
  return {
    uniqueFilename,
    filename,
    hash: crypto.createHash('sha1').update(data).digest('hex'),
    hash256: crypto.createHash('sha256').update(data).digest('hex'),
    length: data.length,
    contentType: 'application/octet-stream',
    uploaded,
    storageType: 'S3',
    storageIds: {},
    doNotCache: true,
  };
}

module.exports = function cloudstorageRoutes(services, config) {
  const router = express.Router();
  const auth = requireAuth(services, { allowClient: true });
  const authUser = requireAuth(services);
  const systemDir = path.join(config.root, 'cloudstorage');

  // "Hotfix" ini files. {{XMPP_HOST}} / {{XMPP_PORT}} are filled in from config.
  function systemFiles() {
    if (!fs.existsSync(systemDir)) return [];
    return fs
      .readdirSync(systemDir)
      .filter((f) => f.endsWith('.ini'))
      .map((filename) => {
        const full = path.join(systemDir, filename);
        const data = Buffer.from(
          fs
            .readFileSync(full, 'utf8')
            .replaceAll('{{XMPP_HOST}}', config.server.publicHost)
            .replaceAll('{{XMPP_PORT}}', String(config.xmpp.port)),
        );
        return { filename, data, uploaded: fs.statSync(full).mtime.toISOString() };
      });
  }

  router.get('/fortnite/api/cloudstorage/system', auth, (req, res) => {
    res.json(systemFiles().map((f) => fileEntry(f.filename, f.data, f.uploaded)));
  });

  router.get('/fortnite/api/cloudstorage/system/config', auth, (req, res) =>
    res.json({ lastUpdated: new Date().toISOString(), disableV2: false, isAuthenticated: true, enumerateFilesPath: '/api/cloudstorage/system', enableMigration: false, enableWrites: false, epicAppName: 'Live', transports: {} }),
  );

  router.get('/fortnite/api/cloudstorage/system/:file', auth, (req, res, next) => {
    const file = systemFiles().find((f) => f.filename === req.params.file);
    if (!file) return next(errors.notFound());
    res.type('application/octet-stream').send(file.data);
  });

  router.get('/fortnite/api/cloudstorage/user/config', auth, (req, res) =>
    res.json({ lastUpdated: new Date().toISOString(), disableV2: true, isAuthenticated: true, enumerateFilesPath: '/api/cloudstorage/user', enableMigration: false, enableWrites: true, epicAppName: 'Live', transports: {} }),
  );

  // Per-player files, mostly ClientSettings.Sav (keybinds, graphics settings).
  router.get('/fortnite/api/cloudstorage/user/:accountId', authUser, requireSelf(), (req, res) => {
    const rows = services.db.prepare('SELECT filename, data, updated_at FROM cloudstorage WHERE account_id = ?').all(req.account.id);
    res.json(rows.map((r) => fileEntry(r.filename, Buffer.from(r.data), r.updated_at, `${req.account.id}/${r.filename}`)));
  });

  router.get('/fortnite/api/cloudstorage/user/:accountId/:file', authUser, requireSelf(), (req, res, next) => {
    const row = services.db.prepare('SELECT data FROM cloudstorage WHERE account_id = ? AND filename = ?').get(req.account.id, req.params.file);
    if (!row) return next(errors.notFound());
    res.type('application/octet-stream').send(Buffer.from(row.data));
  });

  router.put(
    '/fortnite/api/cloudstorage/user/:accountId/:file',
    authUser,
    requireSelf(),
    express.raw({ type: () => true, limit: MAX_USER_FILE }),
    (req, res, next) => {
      if (!FILE_NAME_RE.test(req.params.file)) return next(errors.badRequest('Invalid file name'));
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const exists = services.db.prepare('SELECT 1 FROM cloudstorage WHERE account_id = ? AND filename = ?').get(req.account.id, req.params.file);
      const count = services.db.prepare('SELECT COUNT(*) AS n FROM cloudstorage WHERE account_id = ?').get(req.account.id).n;
      if (!exists && count >= MAX_USER_FILES) return next(errors.badRequest('Too many cloud storage files'));
      services.db
        .prepare(
          `INSERT INTO cloudstorage (account_id, filename, data, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id, filename) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        )
        .run(req.account.id, req.params.file, data, new Date().toISOString());
      res.status(204).end();
    },
  );

  return router;
};
