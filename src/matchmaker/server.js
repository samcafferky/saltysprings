'use strict';

const { hexId } = require('../utils/ids');

const send = (ws, name, payload) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ payload, name }));
};

// Walks the client through the same states Epic's matchmaker sends:
// Connecting -> Waiting -> Queued -> SessionAssignment -> Play.
function handleMatchmaker(ws, req, services) {
  const parts = String(req.headers.authorization || '').split(' ');
  const ticket = parts[0] === 'Epic-Signed' ? services.matchmaking.verifyTicket(parts[2], parts[3]) : null;
  if (!ticket) {
    ws.close(1008, 'Invalid ticket');
    return;
  }

  const ticketId = hexId();
  const matchId = hexId();
  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  ws.on('close', () => timers.forEach(clearTimeout));
  ws.on('error', () => {});

  send(ws, 'StatusUpdate', { state: 'Connecting' });
  later(200, () => send(ws, 'StatusUpdate', { totalPlayers: 1, connectedPlayers: 1, state: 'Waiting' }));
  later(400, () => send(ws, 'StatusUpdate', { ticketId, queuedPlayers: 0, estimatedWaitSec: 0, status: {}, state: 'Queued' }));

  // Keep checking, so players wait in the queue until a matching server is
  // available (servers can be added while running through the admin API).
  const tryAssign = () => {
    const server = services.matchmaking.findServer(ticket);
    if (!server) return later(5000, tryAssign);
    const sessionId = services.matchmaking.createSession(ticket, server);
    send(ws, 'StatusUpdate', { matchId, state: 'SessionAssignment' });
    later(1000, () => send(ws, 'Play', { matchId, sessionId, joinDelaySec: 1 }));
  };
  later(1000, tryAssign);
}

module.exports = { handleMatchmaker };
