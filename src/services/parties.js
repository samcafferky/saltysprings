'use strict';

const { hexId } = require('../utils/ids');
const { EpicError, errors } = require('../utils/errors');

const NS = 'Fortnite';
const TYPE = 'com.epicgames.social.party.notification.v0.';
const PING_TTL_MS = 60 * 60 * 1000;

const partyNotFound = (id) =>
  new EpicError('errors.com.epicgames.social.party.party_not_found', `Sorry, we couldn't find a party by id ${id}`, 51002, 404, [id]);
const memberNotFound = (id) =>
  new EpicError('errors.com.epicgames.social.party.member_not_found', `Sorry, we couldn't find a member by id ${id}`, 51004, 404, [id]);

// Applies a { delete: [...], update: {...} } patch to a meta object.
function patchMeta(meta, patch = {}) {
  for (const key of patch.delete || []) delete meta[key];
  Object.assign(meta, patch.update || {});
}

// Party service used by Season 8+ clients (the "party system v2").
// Parties live in memory: they only matter while players are online.
// Every change is sent to party members over XMPP, like Epic's service does.
class PartyService {
  constructor(accounts, events) {
    this.accounts = accounts;
    this.events = events;
    this.parties = new Map(); // partyId -> party
    this.pings = new Map(); // `${to}:${from}` -> ping
    this.invites = new Map(); // `${partyId}:${to}` -> invite
  }

  displayName(accountId) {
    const account = this.accounts.findById(accountId);
    return account ? account.displayName : accountId;
  }

  notify(accountIds, payload) {
    const sent = new Date().toISOString();
    for (const accountId of accountIds) this.events.emit('xmpp:notify', { accountId, payload: { ...payload, ns: NS, sent } });
  }

  memberIds(party) {
    return party.members.map((m) => m.account_id);
  }

  get(partyId) {
    const party = this.parties.get(partyId);
    if (!party) throw partyNotFound(partyId);
    return party;
  }

  findMember(party, accountId) {
    const member = party.members.find((m) => m.account_id === accountId);
    if (!member) throw memberNotFound(accountId);
    return member;
  }

  currentParty(accountId) {
    for (const party of this.parties.values()) {
      if (party.members.some((m) => m.account_id === accountId)) return party;
    }
    return null;
  }

  newMember(accountId, joinInfo = {}, role) {
    const now = new Date().toISOString();
    const connection = joinInfo.connection || {};
    return {
      account_id: accountId,
      meta: { 'urn:epic:member:dn_s': this.displayName(accountId), ...(joinInfo.meta || {}) },
      connections: [
        {
          id: connection.id || '',
          connected_at: now,
          updated_at: now,
          yield_leadership: Boolean(connection.yield_leadership),
          meta: connection.meta || {},
        },
      ],
      revision: 0,
      updated_at: now,
      joined_at: now,
      role,
    };
  }

  create(accountId, body = {}) {
    // A player is only ever in one party.
    const existing = this.currentParty(accountId);
    if (existing) this.leave(existing.id, accountId);

    const now = new Date().toISOString();
    const party = {
      id: hexId(),
      created_at: now,
      updated_at: now,
      config: {
        type: 'DEFAULT',
        joinability: 'OPEN',
        discoverability: 'ALL',
        sub_type: 'default',
        max_size: 16,
        invite_ttl: 14400,
        join_confirmation: false,
        intention_ttl: 60,
        ...(body.config || {}),
      },
      members: [this.newMember(accountId, body.join_info, 'CAPTAIN')],
      applicants: [],
      meta: { ...(body.meta || {}) },
      invites: [],
      revision: 0,
      intentions: [],
    };
    this.parties.set(party.id, party);
    return party;
  }

  update(partyId, accountId, body = {}) {
    const party = this.get(partyId);
    const captain = party.members.find((m) => m.role === 'CAPTAIN');
    if (!captain || captain.account_id !== accountId) throw errors.forbidden('Only the party leader can change the party');

    if (body.config) Object.assign(party.config, body.config);
    patchMeta(party.meta, body.meta);
    party.revision += 1;
    party.updated_at = new Date().toISOString();

    this.notify(this.memberIds(party), {
      captain_id: captain.account_id,
      created_at: party.created_at,
      invite_ttl_seconds: party.config.invite_ttl,
      max_number_of_members: party.config.max_size,
      party_id: party.id,
      party_privacy_type: party.config.joinability,
      party_state_overriden: {},
      party_state_removed: (body.meta && body.meta.delete) || [],
      party_state_updated: (body.meta && body.meta.update) || {},
      party_sub_type: party.config.sub_type,
      party_type: party.config.type,
      revision: party.revision,
      type: `${TYPE}PARTY_UPDATED`,
      updated_at: party.updated_at,
    });
  }

  updateMember(partyId, accountId, patch = {}) {
    const party = this.get(partyId);
    const member = this.findMember(party, accountId);
    patchMeta(member.meta, patch);
    member.revision += 1;
    member.updated_at = new Date().toISOString();
    party.updated_at = member.updated_at;

    this.notify(this.memberIds(party), {
      account_id: accountId,
      account_dn: member.meta['urn:epic:member:dn_s'],
      member_state_updated: patch.update || {},
      member_state_removed: patch.delete || [],
      member_state_overridden: {},
      party_id: party.id,
      updated_at: member.updated_at,
      revision: member.revision,
      type: `${TYPE}MEMBER_STATE_UPDATED`,
      joined_at: member.joined_at,
    });
  }

  join(partyId, accountId, body = {}) {
    const party = this.get(partyId);
    if (party.members.some((m) => m.account_id === accountId)) return party;

    const invited = this.invites.has(`${party.id}:${accountId}`);
    if (party.config.joinability !== 'OPEN' && !invited) {
      throw new EpicError('errors.com.epicgames.social.party.party_join_forbidden', 'You need an invite to join this party.', 51006, 403);
    }
    if (party.members.length >= party.config.max_size) {
      throw new EpicError('errors.com.epicgames.social.party.party_is_full', 'This party is full.', 51007, 409);
    }

    const old = this.currentParty(accountId);
    if (old) this.leave(old.id, accountId);

    const member = this.newMember(accountId, body, 'MEMBER');
    party.members.push(member);
    party.revision += 1;
    party.updated_at = member.joined_at;
    this.invites.delete(`${party.id}:${accountId}`);
    this.pings.forEach((ping, key) => {
      if (key.startsWith(`${accountId}:`)) this.pings.delete(key);
    });

    this.notify(this.memberIds(party), {
      account_id: accountId,
      account_dn: member.meta['urn:epic:member:dn_s'],
      connection: member.connections[0],
      joined_at: member.joined_at,
      member_state_updated: member.meta,
      party_id: party.id,
      revision: party.revision,
      type: `${TYPE}MEMBER_JOINED`,
      updated_at: member.updated_at,
    });
    return party;
  }

  leave(partyId, accountId) {
    const party = this.get(partyId);
    const member = this.findMember(party, accountId);
    const notifyIds = this.memberIds(party);
    party.members = party.members.filter((m) => m !== member);
    party.revision += 1;

    this.notify(notifyIds, {
      account_id: accountId,
      member_state_update: {},
      party_id: party.id,
      revision: party.revision,
      type: `${TYPE}MEMBER_LEFT`,
    });

    if (!party.members.length) {
      this.parties.delete(party.id);
      return;
    }
    if (member.role === 'CAPTAIN') this.setCaptain(party, party.members[0]);
  }

  promote(partyId, captainId, accountId) {
    const party = this.get(partyId);
    const captain = this.findMember(party, captainId);
    if (captain.role !== 'CAPTAIN') throw errors.forbidden('Only the party leader can promote someone');
    captain.role = 'MEMBER';
    this.setCaptain(party, this.findMember(party, accountId));
  }

  setCaptain(party, member) {
    member.role = 'CAPTAIN';
    party.revision += 1;
    party.updated_at = new Date().toISOString();
    this.notify(this.memberIds(party), {
      account_id: member.account_id,
      account_dn: member.meta['urn:epic:member:dn_s'],
      member_state_updated: {},
      joined_at: member.joined_at,
      party_id: party.id,
      revision: party.revision,
      type: `${TYPE}MEMBER_NEW_CAPTAIN`,
      updated_at: party.updated_at,
    });
  }

  invite(partyId, inviterId, inviteeId, meta = {}) {
    const party = this.get(partyId);
    this.findMember(party, inviterId);
    const now = new Date();
    const invite = {
      party_id: party.id,
      sent_by: inviterId,
      meta,
      sent_to: inviteeId,
      sent_at: now.toISOString(),
      updated_at: now.toISOString(),
      expires_at: new Date(now.getTime() + party.config.invite_ttl * 1000).toISOString(),
      status: 'SENT',
    };
    this.invites.set(`${party.id}:${inviteeId}`, invite);
    party.invites = [...this.invites.values()].filter((i) => i.party_id === party.id);

    this.notify([inviteeId], {
      expires: invite.expires_at,
      meta,
      party_id: party.id,
      inviter_dn: this.displayName(inviterId),
      inviter_id: inviterId,
      invitee_id: inviteeId,
      members_count: party.members.length,
      sent_at: invite.sent_at,
      updated_at: invite.updated_at,
      friends_ids: this.memberIds(party),
      type: `${TYPE}INITIAL_INVITE`,
    });
    this.ping(inviterId, inviteeId, meta);
  }

  declineInvite(partyId, accountId) {
    this.invites.delete(`${partyId}:${accountId}`);
    const party = this.parties.get(partyId);
    if (party) party.invites = party.invites.filter((i) => i.sent_to !== accountId);
  }

  // A "ping" is the "join my party" request a friend sends.
  ping(fromId, toId, meta = {}) {
    const now = new Date();
    const ping = {
      sent_by: fromId,
      sent_to: toId,
      sent_at: now.toISOString(),
      expires_at: new Date(now.getTime() + PING_TTL_MS).toISOString(),
      meta,
    };
    this.pings.set(`${toId}:${fromId}`, ping);
    this.notify([toId], {
      expires: ping.expires_at,
      meta,
      pinger_dn: this.displayName(fromId),
      pinger_id: fromId,
      type: `${TYPE}PING`,
    });
    return ping;
  }

  pingsFor(accountId) {
    const now = new Date().toISOString();
    return [...this.pings.entries()]
      .filter(([key, ping]) => key.startsWith(`${accountId}:`) && ping.expires_at > now)
      .map(([, ping]) => ping);
  }

  deletePing(toId, fromId) {
    this.pings.delete(`${toId}:${fromId}`);
  }

  // Parties the pinger is in, so the pinged player can join them.
  pingerParties(toId, fromId) {
    if (!this.pings.has(`${toId}:${fromId}`)) return [];
    const party = this.currentParty(fromId);
    return party ? [party] : [];
  }

  userSummary(accountId) {
    const current = this.currentParty(accountId);
    return {
      current: current ? [current] : [],
      pending: [],
      invites: [...this.invites.values()].filter((i) => i.sent_to === accountId),
      pings: this.pingsFor(accountId),
    };
  }

  // Called when a player's XMPP connection closes for good.
  removeEverywhere(accountId) {
    const party = this.currentParty(accountId);
    if (party) this.leave(party.id, accountId);
  }
}

module.exports = { PartyService };
