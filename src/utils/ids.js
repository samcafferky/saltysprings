'use strict';

const crypto = require('node:crypto');

const newAccountId = () => crypto.randomBytes(16).toString('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const uuid = () => crypto.randomUUID();
const hexId = () => uuid().replace(/-/g, '');

module.exports = { newAccountId, newToken, sha256, uuid, hexId };
