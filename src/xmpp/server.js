'use strict';

const { XMLParser } = require('fast-xml-parser');
const { hexId } = require('../utils/ids');

const NS_FRAMING = 'urn:ietf:params:xml:ns:xmpp-framing';
const NS_SASL = 'urn:ietf:params:xml:ns:xmpp-sasl';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
});

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

const text = (node) => (node === undefined || node === null ? '' : typeof node === 'object' ? String(node['#text'] ?? '') : String(node));
const attr = (node, name) => (node && typeof node === 'object' ? node[`@_${name}`] : undefined);

function parseStanza(raw) {
  if (/<!(DOCTYPE|ENTITY)/i.test(raw)) return null;
  try {
    const doc = parser.parse(raw);
    const name = Object.keys(doc).find((k) => !k.startsWith('?'));
    return name ? { name, node: doc[name] === '' ? {} : doc[name] } : null;
  } catch {
    return null;
  }
}

// Minimal XMPP-over-WebSocket server (RFC 7395) with the parts Fortnite uses:
// login, presence between friends, direct messages and party chat rooms (MUC).
class XmppServer {
  constructor(services, config) {
    this.services = services;
    this.domain = config.xmpp.domain;
    this.mucDomain = `muc.${this.domain}`;
    this.clients = new Map(); // accountId -> Set<client>
    this.rooms = new Map(); // room name -> Map<jid, { client, nick }>
    this.bindEvents(services.events);
  }

  handleConnection(ws) {
    const client = { ws, id: hexId(), accountId: null, jid: null, resource: null, authed: false, presence: null, rooms: new Set() };
    ws.on('message', (data) => {
      const stanza = parseStanza(data.toString());
      if (!stanza) return this.close(client);
      try {
        this.handle(client, stanza);
      } catch (err) {
        this.services.logger.warn(`[xmpp] error handling ${stanza.name}: ${err.message}`);
      }
    });
    ws.on('close', () => this.disconnect(client));
    ws.on('error', () => {});
  }

  send(client, xml) {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(xml);
  }

  close(client) {
    this.send(client, `<close xmlns="${NS_FRAMING}"/>`);
    client.ws.close();
  }

  handle(client, { name, node }) {
    if (name === 'open') return this.onOpen(client);
    if (name === 'close') return this.close(client);
    if (name === 'auth') return this.onAuth(client, node);
    if (!client.authed) return this.close(client);
    if (name === 'iq') return this.onIq(client, node);
    if (name === 'presence') return this.onPresence(client, node);
    if (name === 'message') return this.onMessage(client, node);
  }

  onOpen(client) {
    this.send(client, `<open xmlns="${NS_FRAMING}" from="${this.domain}" id="${hexId()}" version="1.0" xml:lang="en"/>`);
    if (!client.authed) {
      this.send(
        client,
        `<stream:features xmlns:stream="http://etherx.jabber.org/streams"><mechanisms xmlns="${NS_SASL}"><mechanism>PLAIN</mechanism></mechanisms><ver xmlns="urn:xmpp:features:rosterver"/><auth xmlns="http://jabber.org/features/iq-auth"/></stream:features>`,
      );
    } else {
      this.send(
        client,
        `<stream:features xmlns:stream="http://etherx.jabber.org/streams"><ver xmlns="urn:xmpp:features:rosterver"/><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"/><session xmlns="urn:ietf:params:xml:ns:xmpp-session"/></stream:features>`,
      );
    }
  }

  // SASL PLAIN: base64("\0<accountId>\0<access token>").
  onAuth(client, node) {
    const parts = Buffer.from(text(node), 'base64').toString('utf8').split('\0');
    const token = (parts[parts.length - 1] || '').replace(/^eg1~/, '');
    const claimedId = parts[parts.length - 2];
    const found = this.services.tokens.find(token, ['access']);
    const account = found && this.services.accounts.findById(found.accountId);
    if (!account || account.banned || (claimedId && claimedId !== account.id)) {
      this.send(client, `<failure xmlns="${NS_SASL}"><not-authorized/><text xml:lang="eng">Password not verified</text></failure>`);
      return this.close(client);
    }
    client.authed = true;
    client.accountId = account.id;
    client.displayName = account.displayName;
    this.send(client, `<success xmlns="${NS_SASL}"/>`);
  }

  onIq(client, node) {
    const id = escapeXml(attr(node, 'id') || '');
    const type = attr(node, 'type');

    if (node.bind !== undefined) {
      const resource = text(node.bind.resource) || `V2:Fortnite:WIN::${hexId()}`;
      client.resource = resource;
      client.jid = `${client.accountId}@${this.domain}/${resource}`;
      if (!this.clients.has(client.accountId)) this.clients.set(client.accountId, new Set());
      this.clients.get(client.accountId).add(client);
      return this.send(
        client,
        `<iq type="result" id="${id}" to="${escapeXml(client.jid)}" xmlns="jabber:client"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><jid>${escapeXml(client.jid)}</jid></bind></iq>`,
      );
    }

    const to = client.jid ? ` to="${escapeXml(client.jid)}"` : '';
    this.send(client, `<iq${to} from="${this.domain}" id="${id}" xmlns="jabber:client" type="result"/>`);

    // After the session starts, show this player which friends are online.
    if (node.session !== undefined && type === 'set' && client.jid) {
      for (const friend of this.services.friends.friends(client.accountId)) {
        for (const other of this.clients.get(friend.accountId) || []) {
          if (other.presence) this.send(client, this.presenceXml(other, client.jid));
        }
      }
    }
  }

  presenceXml(from, toJid, typeOverride) {
    const p = from.presence || {};
    const type = typeOverride || (p.unavailable ? 'unavailable' : 'available');
    const show = p.show ? `<show>${escapeXml(p.show)}</show>` : '';
    return `<presence to="${escapeXml(toJid)}" xmlns="jabber:client" from="${escapeXml(from.jid)}" type="${type}">${show}<status>${escapeXml(p.status || '')}</status></presence>`;
  }

  // Sends this client's presence to every online friend.
  broadcastPresence(client, typeOverride) {
    if (!client.jid) return;
    for (const friend of this.services.friends.friends(client.accountId)) {
      for (const other of this.clients.get(friend.accountId) || []) {
        if (other.jid) this.send(other, this.presenceXml(client, other.jid, typeOverride));
      }
    }
  }

  onPresence(client, node) {
    if (!client.jid) return;
    const to = attr(node, 'to');
    const type = attr(node, 'type');
    if (to && to.split('@')[1] && to.split('@')[1].split('/')[0] === this.mucDomain) {
      return type === 'unavailable' ? this.leaveRoom(client, to.split('@')[0]) : this.joinRoom(client, to, node);
    }
    client.presence = {
      status: text(node.status),
      show: text(node.show),
      unavailable: type === 'unavailable',
    };
    this.broadcastPresence(client);
  }

  joinRoom(client, to, node) {
    const roomName = to.split('@')[0];
    if (this.rooms.has(roomName) && this.rooms.get(roomName).size >= 32 && !this.rooms.get(roomName).has(client.jid)) return;
    const nick = to.split('/')[1] || `${client.displayName}:${client.accountId}:${client.resource}`;
    if (!this.rooms.has(roomName)) this.rooms.set(roomName, new Map());
    const room = this.rooms.get(roomName);
    const roomJid = `${roomName}@${this.mucDomain}`;
    const item = (m) =>
      `<x xmlns="http://jabber.org/protocol/muc#user"><item nick="${escapeXml(m.nick)}" jid="${escapeXml(m.client.jid)}" role="participant" affiliation="none"/></x>`;

    // Existing members -> new member.
    for (const member of room.values()) {
      this.send(client, `<presence to="${escapeXml(client.jid)}" from="${escapeXml(`${roomJid}/${member.nick}`)}" xmlns="jabber:client">${item(member)}</presence>`);
    }
    const me = { client, nick };
    room.set(client.jid, me);
    client.rooms.add(roomName);

    // New member -> everyone (including themselves, with status 110 = "this is you").
    for (const member of room.values()) {
      const self = member.client === client ? '<status code="110"/><status code="100"/><status code="170"/>' : '';
      this.send(
        member.client,
        `<presence to="${escapeXml(member.client.jid)}" from="${escapeXml(`${roomJid}/${nick}`)}" xmlns="jabber:client"><x xmlns="http://jabber.org/protocol/muc#user"><item nick="${escapeXml(nick)}" jid="${escapeXml(client.jid)}" role="participant" affiliation="none"/>${self}</x></presence>`,
      );
    }
  }

  leaveRoom(client, roomName) {
    const room = this.rooms.get(roomName);
    if (!room || !room.has(client.jid)) return;
    const { nick } = room.get(client.jid);
    const roomJid = `${roomName}@${this.mucDomain}`;
    for (const member of room.values()) {
      this.send(
        member.client,
        `<presence to="${escapeXml(member.client.jid)}" from="${escapeXml(`${roomJid}/${nick}`)}" xmlns="jabber:client" type="unavailable"><x xmlns="http://jabber.org/protocol/muc#user"><item nick="${escapeXml(nick)}" jid="${escapeXml(client.jid)}" role="none" affiliation="none"/></x></presence>`,
      );
    }
    room.delete(client.jid);
    client.rooms.delete(roomName);
    if (!room.size) this.rooms.delete(roomName);
  }

  onMessage(client, node) {
    const to = attr(node, 'to');
    const type = attr(node, 'type') || 'chat';
    const body = text(node.body);
    if (!to || !client.jid) return;
    const id = attr(node, 'id') ? ` id="${escapeXml(attr(node, 'id'))}"` : '';
    const [user, hostAndResource = ''] = to.split('@');
    const host = hostAndResource.split('/')[0];

    if (type === 'groupchat' && host === this.mucDomain) {
      const room = this.rooms.get(user);
      if (!room || !room.has(client.jid)) return;
      const from = `${user}@${this.mucDomain}/${room.get(client.jid).nick}`;
      for (const member of room.values()) {
        if (member.client === client) continue;
        this.send(member.client, `<message to="${escapeXml(member.client.jid)}" from="${escapeXml(from)}" type="groupchat" xmlns="jabber:client"${id}><body>${escapeXml(body)}</body></message>`);
      }
      return;
    }

    // Direct message (chat, party invites, join requests...).
    if (host !== this.domain || this.services.friends.isBlocked(client.accountId, user)) return;
    const resource = hostAndResource.split('/')[1];
    for (const target of this.clients.get(user) || []) {
      if (resource && target.resource !== resource) continue;
      this.send(target, `<message to="${escapeXml(target.jid)}" from="${escapeXml(client.jid)}" type="${escapeXml(type)}" xmlns="jabber:client"${id}><body>${escapeXml(body)}</body></message>`);
    }
  }

  disconnect(client) {
    for (const roomName of [...client.rooms]) this.leaveRoom(client, roomName);
    const set = this.clients.get(client.accountId);
    if (set) {
      set.delete(client);
      if (!set.size) this.clients.delete(client.accountId);
    }
    if (client.jid && client.presence) this.broadcastPresence(client, 'unavailable');
  }

  // Server -> player notification (friend requests etc.), sent from xmpp-admin.
  notify(accountId, payload) {
    for (const client of this.clients.get(accountId) || []) {
      this.send(client, `<message from="xmpp-admin@${this.domain}" to="${escapeXml(client.jid)}" xmlns="jabber:client"><body>${escapeXml(JSON.stringify(payload))}</body></message>`);
    }
  }

  // Swaps presence between two players who just became friends.
  exchangePresence(a, b) {
    for (const ca of this.clients.get(a) || []) {
      for (const cb of this.clients.get(b) || []) {
        if (ca.presence && cb.jid) this.send(cb, this.presenceXml(ca, cb.jid));
        if (cb.presence && ca.jid) this.send(ca, this.presenceXml(cb, ca.jid));
      }
    }
  }

  bindEvents(events) {
    const now = () => new Date().toISOString();
    const friendPayload = (accountId, status, direction, created) => ({
      payload: { accountId, status, direction, created, favorite: false },
      type: 'com.epicgames.friends.core.apiobjects.Friend',
      timestamp: now(),
    });

    events.on('friend:requested', ({ accountId, friendId, created }) => {
      this.notify(accountId, friendPayload(friendId, 'PENDING', 'OUTBOUND', created));
      this.notify(friendId, friendPayload(accountId, 'PENDING', 'INBOUND', created));
      const legacy = { type: 'FRIENDSHIP_REQUEST', timestamp: now(), from: accountId, to: friendId, status: 'PENDING' };
      this.notify(accountId, legacy);
      this.notify(friendId, legacy);
    });

    events.on('friend:accepted', ({ accountId, friendId, created }) => {
      this.notify(accountId, friendPayload(friendId, 'ACCEPTED', 'INBOUND', created));
      this.notify(friendId, friendPayload(accountId, 'ACCEPTED', 'OUTBOUND', created));
      const legacy = { type: 'FRIENDSHIP_REQUEST', timestamp: now(), from: friendId, to: accountId, status: 'ACCEPTED' };
      this.notify(accountId, legacy);
      this.notify(friendId, legacy);
      this.exchangePresence(accountId, friendId);
    });

    events.on('friend:removed', ({ accountId, friendId }) => {
      const removal = (id) => ({ payload: { accountId: id, reason: 'DELETED' }, type: 'com.epicgames.friends.core.apiobjects.FriendRemoval', timestamp: now() });
      this.notify(accountId, removal(friendId));
      this.notify(friendId, removal(accountId));
      const legacy = { type: 'FRIENDSHIP_REMOVE', timestamp: now(), from: accountId, to: friendId, reason: 'DELETED' };
      this.notify(accountId, legacy);
      this.notify(friendId, legacy);
      // Each side now sees the other as offline.
      for (const ca of this.clients.get(accountId) || []) {
        for (const cb of this.clients.get(friendId) || []) {
          if (cb.jid && ca.jid) {
            this.send(cb, this.presenceXml(ca, cb.jid, 'unavailable'));
            this.send(ca, this.presenceXml(cb, ca.jid, 'unavailable'));
          }
        }
      }
    });

    events.on('friend:blocked', ({ accountId, blockedId }) => {
      this.notify(accountId, { payload: { accountId: blockedId }, type: 'com.epicgames.friends.core.apiobjects.BlockListEntryAdded', timestamp: now() });
    });

    events.on('friend:unblocked', ({ accountId, blockedId }) => {
      this.notify(accountId, { payload: { accountId: blockedId }, type: 'com.epicgames.friends.core.apiobjects.BlockListEntryRemoved', timestamp: now() });
    });

    events.on('account:banned', ({ accountId }) => {
      for (const client of this.clients.get(accountId) || []) this.close(client);
    });
  }

  onlineCount() {
    return this.clients.size;
  }
}

module.exports = { XmppServer, escapeXml, parseStanza };
