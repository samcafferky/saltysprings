'use strict';

const { transaction } = require('../db/database');
const { EpicError, errors } = require('../utils/errors');

// Friends, friend requests and blocks. Every change emits an event so the
// XMPP server can tell online players about it right away.
class FriendService {
  constructor(db, accounts, events) {
    this.db = db;
    this.accounts = accounts;
    this.events = events;
  }

  friends(accountId) {
    return this.db.prepare('SELECT friend_id AS accountId, created_at AS created FROM friends WHERE account_id = ?').all(accountId);
  }

  incoming(accountId) {
    return this.db.prepare('SELECT from_id AS accountId, created_at AS created FROM friend_requests WHERE to_id = ?').all(accountId);
  }

  outgoing(accountId) {
    return this.db.prepare('SELECT to_id AS accountId, created_at AS created FROM friend_requests WHERE from_id = ?').all(accountId);
  }

  blocked(accountId) {
    return this.db.prepare('SELECT blocked_id AS accountId, created_at AS created FROM blocks WHERE account_id = ?').all(accountId);
  }

  areFriends(a, b) {
    return Boolean(this.db.prepare('SELECT 1 FROM friends WHERE account_id = ? AND friend_id = ?').get(a, b));
  }

  isBlocked(a, b) {
    return Boolean(this.db.prepare('SELECT 1 FROM blocks WHERE (account_id = ? AND blocked_id = ?) OR (account_id = ? AND blocked_id = ?)').get(a, b, b, a));
  }

  // Sends a request, or accepts one if the other player already sent theirs.
  // Returns "requested" or "accepted".
  add(accountId, friendId) {
    if (accountId === friendId) throw errors.badRequest('You cannot add yourself as a friend.');
    if (!this.accounts.findById(friendId)) {
      throw new EpicError('errors.com.epicgames.friends.account_not_found', `Account ${friendId} does not exist`, 14011, 404, [friendId]);
    }
    if (this.isBlocked(accountId, friendId)) {
      throw new EpicError('errors.com.epicgames.friends.blocked', 'That player is blocked.', 14015, 403);
    }
    if (this.areFriends(accountId, friendId)) {
      throw new EpicError('errors.com.epicgames.friends.duplicate_friendship', `Friendship between ${accountId} and ${friendId} already exists.`, 14009, 409);
    }

    const now = new Date().toISOString();
    const theirRequest = this.db.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').get(friendId, accountId);
    if (theirRequest) {
      transaction(this.db, () => {
        this.db.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?').run(friendId, accountId);
        const insert = this.db.prepare('INSERT OR IGNORE INTO friends (account_id, friend_id, created_at) VALUES (?, ?, ?)');
        insert.run(accountId, friendId, now);
        insert.run(friendId, accountId, now);
      });
      this.events.emit('friend:accepted', { accountId, friendId, created: now });
      return 'accepted';
    }

    const existing = this.db.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').get(accountId, friendId);
    if (existing) {
      throw new EpicError('errors.com.epicgames.friends.friend_request_already_sent', `Friendship request has already been sent to ${friendId}`, 14014, 409, [friendId]);
    }
    this.db.prepare('INSERT INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)').run(accountId, friendId, now);
    this.events.emit('friend:requested', { accountId, friendId, created: now });
    return 'requested';
  }

  // Removes a friend, or cancels/declines a pending request.
  remove(accountId, friendId) {
    const removed = transaction(this.db, () => {
      let changes = this.db.prepare('DELETE FROM friends WHERE (account_id = ? AND friend_id = ?) OR (account_id = ? AND friend_id = ?)').run(accountId, friendId, friendId, accountId).changes;
      changes += this.db.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').run(accountId, friendId, friendId, accountId).changes;
      return changes;
    });
    if (!removed) {
      throw new EpicError('errors.com.epicgames.friends.friendship_not_found', `Friendship between ${accountId} and ${friendId} does not exist`, 14004, 404);
    }
    this.events.emit('friend:removed', { accountId, friendId });
  }

  block(accountId, blockedId) {
    if (accountId === blockedId) throw errors.badRequest('You cannot block yourself.');
    if (!this.accounts.findById(blockedId)) throw errors.notFound();
    const wasFriend = this.areFriends(accountId, blockedId);
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM friends WHERE (account_id = ? AND friend_id = ?) OR (account_id = ? AND friend_id = ?)').run(accountId, blockedId, blockedId, accountId);
      this.db.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').run(accountId, blockedId, blockedId, accountId);
      this.db.prepare('INSERT OR IGNORE INTO blocks (account_id, blocked_id, created_at) VALUES (?, ?, ?)').run(accountId, blockedId, new Date().toISOString());
    });
    if (wasFriend) this.events.emit('friend:removed', { accountId, friendId: blockedId });
    this.events.emit('friend:blocked', { accountId, blockedId });
  }

  unblock(accountId, blockedId) {
    this.db.prepare('DELETE FROM blocks WHERE account_id = ? AND blocked_id = ?').run(accountId, blockedId);
    this.events.emit('friend:unblocked', { accountId, blockedId });
  }
}

module.exports = { FriendService };
