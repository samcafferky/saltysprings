'use strict';

const path = require('node:path');
const express = require('express');
const { EpicError, errors } = require('./utils/errors');

function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    let error = err;
    if (!(err instanceof EpicError)) {
      if (err.type === 'entity.too.large') error = new EpicError('errors.com.epicgames.common.request_too_large', 'Request body is too large', 1013, 413);
      else if (err.status === 400 || err.type === 'entity.parse.failed') error = errors.badRequest('Malformed request body');
      else {
        logger.error(`[error] ${req.method} ${req.originalUrl}:`, err);
        error = new EpicError('errors.com.epicgames.common.server_error', 'Sorry an error occurred and we were unable to resolve it.', 1000, 500);
      }
    }
    res.setHeader('X-Epic-Error-Name', error.errorCode);
    res.setHeader('X-Epic-Error-Code', String(error.numericErrorCode));
    res.status(error.status).json(error.toJSON());
  };
}

function createApp(services, config) {
  const app = express();
  const { logger } = services;
  app.disable('x-powered-by');
  app.set('trust proxy', Boolean(config.server.trustProxy));

  if (config.server.logRequests) {
    app.use((req, res, next) => {
      res.on('finish', () => logger.log(`[http] ${req.method} ${req.originalUrl} -> ${res.statusCode}`));
      next();
    });
  }

  // Cloud storage uploads are raw bytes, so this router goes before the JSON parser.
  app.use(require('./routes/cloudstorage')(services, config));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  app.use(require('./routes/account')(services, config));
  app.use(require('./routes/mcp')(services, config));
  app.use(require('./routes/game')(services, config));
  app.use(require('./routes/friends')(services, config));
  app.use(require('./routes/matchmaking')(services, config));
  app.use(require('./routes/party')(services, config));
  app.use(require('./routes/web')(services, config));
  app.use(require('./routes/admin')(services, config));
  app.use(express.static(path.join(config.root, 'public')));

  app.use((req, res, next) => {
    logger.warn(`[http] no route for ${req.method} ${req.originalUrl}`);
    next(errors.notFound());
  });
  app.use(errorHandler(logger));
  return app;
}

module.exports = { createApp };
