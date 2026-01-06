// server/server.js
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import { nanoid } from 'nanoid';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const allowOrigin = (process.env.CORS_ORIGIN === '*' || !process.env.CORS_ORIGIN)
  ? true
  : process.env.CORS_ORIGIN.split(',').map(s => s.trim());
app.use(cors({ origin: allowOrigin }));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: allowOrigin }
});

const PORT = process.env.PORT || 4000;

// --- In-memory room store (single-instance) ---
// For multi-instance use Redis + adapter (not shown here)
const DEFAULT_DECK = ['0','1','2','3','5','8','13','20','40','100','?','☕'];
const rooms = new Map();
//room logger
function logRoom(roomId, message, extra = {}) {
  const timestamp = new Date().toISOString();
  const meta = Object.keys(extra).length ? ` | ${JSON.stringify(extra)}` : '';
  console.log(`[${timestamp}] [ROOM ${roomId}] ${message}${meta}`);
}

// helper to create room
function createRoom({ deck = DEFAULT_DECK } = {}) {
  const id = nanoid(8);
  const room = {
    id,
    deck: [...deck],
    story: '',
    revealed: false,
    // users keyed by clientId:
    // clientId -> { clientId, name, vote, host, spectator, sockets: Set(socketId) }
    users: {},
    createdAt: Date.now()
  };
  rooms.set(id, room);
  logRoom(id, 'Room created', { deckSize: deck.length });
  return room;
}
function getRoom(roomId) { return rooms.get(roomId); }

// socketId -> clientId
const socketToClient = new Map();

// Helper: public state (hide raw votes until reveal)
function roomStatePublic(room) {
  const users = Object.fromEntries(
    Object.entries(room.users).map(([cid, u]) => [
      cid,
      {
        clientId: cid,
        name: u.name,
        voted: u.vote !== null,
        spectator: !!u.spectator,
        host: !!u.host
      }
    ])
  );
  return {
    id: room.id,
    deck: room.deck,
    story: room.story,
    revealed: room.revealed,
    users
  };
}

function computeRevealPayload(room) {
  const entries = Object.entries(room.users).map(([cid, u]) => ({
    id: cid,
    name: u.name,
    vote: u.vote
  }));
  const numericVotes = entries
    .map(e => parseFloat(e.vote))
    .filter(v => Number.isFinite(v));
  const average = numericVotes.length
    ? numericVotes.reduce((a,b) => a + b, 0) / numericVotes.length
    : null;
  return { votes: entries, average };
}

// --- REST endpoints ---
app.post('/api/rooms', (req, res) => {
  const { deck } = req.body || {};
  const room = createRoom({ deck });
  res.json({ roomId: room.id });
});

app.get('/health', (_, res) => res.json({ ok: true }));

// --- Socket handlers ---
io.on('connection', (socket) => {
  // current room id for this socket (optional convenience)
  let currentRoomId = null;

  socket.on('join_room', ({ roomId, name, asHost, asSpectator, clientId } = {}, ack) => {
    const room = getRoom(roomId);
    if (!room) return ack?.({ ok: false, error: 'ROOM_NOT_FOUND' });

    const raw = String(name || '').trim();
    if (!raw) return ack?.({ ok: false, error: 'EMPTY_NAME' });

    // choose stable client id or create one
    const cid = clientId || nanoid(8);

    // ensure unique display name among other clientIds
    const taken = Object.entries(room.users).some(([existingCid, u]) =>
      existingCid !== cid && (u.name || '').trim().toLowerCase() === raw.toLowerCase()
    );
    if (taken) return ack?.({ ok: false, error: 'NAME_TAKEN' });

    // map socket -> client
    socketToClient.set(socket.id, cid);

    // join the socket to the room
    socket.join(roomId);
    currentRoomId = roomId;

    // create or update stable user entry
    if (!room.users[cid]) {
      room.users[cid] = { clientId: cid, name: raw, vote: null, host: !!asHost, spectator: !!asSpectator, sockets: new Set([socket.id]) };
    } else {
      // re-associate a reconnect: add socket to sockets set
      room.users[cid].sockets.add(socket.id);
      // update display name and flags in case they changed
      room.users[cid].name = raw;
      room.users[cid].spectator = !!asSpectator;
      // don't overwrite host unless explicitly provided true (keep existing)
      if (asHost) room.users[cid].host = true;
    }

    room.revealed = false; // hide votes when someone rejoins / joins
    io.to(roomId).emit('room_state', roomStatePublic(room));
    ack?.({ ok: true, room: roomStatePublic(room), clientId: cid });
  });

  socket.on('set_story', ({ roomId, story } = {}) => {
    const room = getRoom(roomId);
    if (!room) return;
    room.story = String(story || '').slice(0, 280);
    io.to(roomId).emit('room_state', roomStatePublic(room));
  });

  socket.on('set_deck', ({ roomId, deck } = {}) => {
    const room = getRoom(roomId);
    if (!room || !Array.isArray(deck) || !deck.length) return;
    room.deck = deck.map(String);
    io.to(roomId).emit('room_state', roomStatePublic(room));
  });

  socket.on('cast_vote', ({ roomId, value } = {}, ack) => {
    const room = getRoom(roomId);
    if (!room) return ack?.({ ok: false });
    const cid = socketToClient.get(socket.id);
    if (!cid || !room.users[cid]) return ack?.({ ok: false });

    // optionally disallow voting after reveal - currently allowed and will update results
    room.users[cid].vote = String(value);
    io.to(roomId).emit('room_state', roomStatePublic(room));

    // if results are already revealed, recompute and re-send them
    if (room.revealed) {
      io.to(roomId).emit('reveal_result', computeRevealPayload(room));
    }

    ack?.({ ok: true });
  });

  socket.on('reveal', ({ roomId } = {}, ack) => {
    const room = getRoom(roomId);
    if (!room) return ack?.({ ok: false });
    room.revealed = true;
    io.to(roomId).emit('reveal_result', computeRevealPayload(room));
    io.to(roomId).emit('room_state', roomStatePublic(room));
    ack?.({ ok: true });
  });

  socket.on('reset', ({ roomId, clearStory } = {}, ack) => {
    const room = getRoom(roomId);
    if (!room) return ack?.({ ok: false });
    room.revealed = false;
    if (clearStory) room.story = '';
    Object.values(room.users).forEach(u => u.vote = null);
    io.to(roomId).emit('room_state', roomStatePublic(room));
    ack?.({ ok: true });
  });

  // Throw handler (pass-through, server doesn't compute layout)
  socket.on('throw', ({ roomId, item, img, side, targetId } = {}, ack) => {
    if (!roomId) return ack?.({ ok: false });
    const payload = {
      id: nanoid(6),
      item: item ? String(item) : null,
      img: img || null,
      side: side === 'right' ? 'right' : 'left',
      targetId: targetId || null,
      s1: Math.random(),
      s2: Math.random()
    };
    io.to(roomId).emit('throw', payload);
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const cid = socketToClient.get(socket.id);
    socketToClient.delete(socket.id);

    if (!cid) return;
    // remove socket from any room user mapping(s)
    // if we tracked currentRoomId above, use it; otherwise search all rooms (cheap here)
    for (const [roomId, room] of rooms.entries()) {
      if (room.users[cid]) {
        room.users[cid].sockets.delete(socket.id);
        // if no sockets left, remove the user (or keep and mark offline; here we remove)
        if (room.users[cid].sockets.size === 0) {
          delete room.users[cid];
        }
        io.to(roomId).emit('room_state', roomStatePublic(room));
      }
    }
  });
});

// --- Serve built client (single-port prod) ---
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(CLIENT_DIST));
app.get('*', (_, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});