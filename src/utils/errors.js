'use strict';

// Errors in the same shape Epic's services return, so the game client can read them.
class EpicError extends Error {
  constructor(errorCode, message, numericErrorCode = 1000, status = 400, messageVars = []) {
    super(message);
    this.errorCode = errorCode;
    this.numericErrorCode = numericErrorCode;
    this.status = status;
    this.messageVars = messageVars;
  }

  toJSON() {
    return {
      errorCode: this.errorCode,
      errorMessage: this.message,
      messageVars: this.messageVars,
      numericErrorCode: this.numericErrorCode,
      originatingService: 'any',
      intent: 'prod',
      error_description: this.message,
    };
  }
}

const errors = {
  notFound: () =>
    new EpicError('errors.com.epicgames.common.not_found', 'Sorry the resource you were trying to find could not be found', 1004, 404),
  invalidToken: (token) =>
    new EpicError(
      'errors.com.epicgames.common.authentication.token_verification_failed',
      `Sorry the auth token '${token}' is invalid`,
      1014,
      401,
      [token],
    ),
  missingAuth: () =>
    new EpicError(
      'errors.com.epicgames.common.authentication.authentication_failed',
      'Authentication failed: no valid auth token was provided',
      1032,
      401,
    ),
  forbidden: (message = 'You do not have permission to do that') =>
    new EpicError('errors.com.epicgames.common.missing_permission', message, 1023, 403),
  badRequest: (message = 'Bad request') =>
    new EpicError('errors.com.epicgames.common.bad_request', message, 1001, 400),
  invalidCredentials: () =>
    new EpicError(
      'errors.com.epicgames.account.invalid_account_credentials',
      'Your e-mail and/or password are incorrect. Please check them and try again.',
      18031,
      400,
    ),
  banned: () =>
    new EpicError('errors.com.epicgames.account.account_not_active', 'This account has been banned.', 18006, 400),
  unsupportedGrant: (grant) =>
    new EpicError('errors.com.epicgames.common.oauth.unsupported_grant_type', `Unsupported grant type: ${grant}`, 1016, 400),
  invalidGrant: (message) => new EpicError('errors.com.epicgames.account.oauth.invalid_grant', message, 18036, 400),
  tooManyRequests: () =>
    new EpicError('errors.com.epicgames.common.throttled', 'Too many requests. Please wait and try again.', 1041, 429),
  operationNotFound: (op) =>
    new EpicError('errors.com.epicgames.fortnite.operation_not_found', `Operation ${op} not valid`, 16035, 404, [op]),
  itemNotFound: (itemId) =>
    new EpicError('errors.com.epicgames.fortnite.item_not_found', `Item ${itemId} not found`, 16006, 404, [itemId]),
};

module.exports = { EpicError, errors };
