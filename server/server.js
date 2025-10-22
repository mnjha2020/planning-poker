// server/server.js ss
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import { nanoid } from 'nanoid';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
app.use(express.json());
// Allow one or many origins via env, or * for dev
const allowOrigin = (process.env.CORS_ORIGIN === '*' || !process.env.CORS_ORIGIN)
  ? true
  : process.env.CORS_ORIGIN.split(',').map(s => s.trim());
app.use(cors({ origin: allowOrigin }));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: allowOrigin }
});

const PORT = process.env.PORT || 4000;

// --- In-memory room store --- //
// NOTE: Use Redis or a DB for production scale or multi-instance.
const DEFAULT_DECK = ['0', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', '☕'];
const rooms = new Map();

function createRoom({ deck = DEFAULT_DECK }) {
  const id = nanoid(8);
  rooms.set(id, {
    id,
    deck: [...deck],
    story: '',
    revealed: false,
    users: {}, // socketId -> { name, vote: null }
    createdAt: Date.now()
  });
  return rooms.get(id);
}

function getRoom(roomId) { return rooms.get(roomId); }

function roomStatePublic(room) {
  const users = Object.fromEntries(
    Object.entries(room.users).map(([sid, u]) => [sid, {
      name: u.name,
      voted: u.vote !== null,
      spectator: !!u.spectator,
      host: !!u.host,          // <- optional
    }])
  );
  return { id: room.id, deck: room.deck, story: room.story, revealed: room.revealed, users };
}

function computeRevealPayload(room) {
  // shape: { votes: [{ id, name, vote }...], average: number|null }
  const entries = Object.entries(room.users).map(([sid, u]) => ({
    id: sid,
    name: u.name,
    vote: u.vote
  }));
  const numericVotes = entries
    .map(e => parseFloat(e.vote))
    .filter(v => Number.isFinite(v));
  const average = numericVotes.length
    ? numericVotes.reduce((a, b) => a + b, 0) / numericVotes.length
    : null;

  return { votes: entries, average };
}


// --- REST endpoints --- //
app.post('/api/rooms', (req, res) => {
  const { deck } = req.body || {};
  const room = createRoom({ deck });
  res.json({ roomId: room.id });
});

// Simple health
app.get('/health', (_, res) => res.json({ ok: true }));

// --- Socket handlers --- //
io.on('connection', (socket) => {
  let currentRoomId = null;

  socket.on('join_room', ({ roomId, name, asHost,asSpectator } = {}, ack) => {
    const room = getRoom(roomId);
    if (!room) return ack?.({ ok: false, error: 'ROOM_NOT_FOUND' });

    const raw = String(name || '').trim();
    if (!raw) return ack?.({ ok: false, error: 'EMPTY_NAME' });

    // block duplicate display names (case-insensitive)
    const taken = Object.values(room.users).some(
      u => (u.name || '').trim().toLowerCase() === raw.toLowerCase()
    );
    if (taken) return ack?.({ ok: false, error: 'NAME_TAKEN' });

    currentRoomId = roomId;
    socket.join(roomId);

    // ✅ actually store the name
     room.users[socket.id] = {
        name: raw,
        vote: null,
        host: !!asHost,
        spectator: !!asSpectator   // ✅ mark spectator
      };
    room.revealed = false;

    // broadcast the updated public state
    io.to(roomId).emit('room_state', roomStatePublic(room));
    ack?.({ ok: true, room: roomStatePublic(room) });
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
    if (!room.users[socket.id]) return ack?.({ ok: false });
    room.users[socket.id].vote = String(value);
    io.to(roomId).emit('room_state', roomStatePublic(room));
    + // If results are already revealed, recompute & re-send the results
    + if (room.revealed) {
    +   io.to(roomId).emit('reveal_result', computeRevealPayload(room));
    + }
    ack?.({ ok: true });
  });

  socket.on('reveal', ({ roomId } = {}) => {
    const room = getRoom(roomId);
    if (!room) return;
    room.revealed = true;
    io.to(roomId).emit('reveal_result', computeRevealPayload(room));
  });

  socket.on('reset', ({ roomId, clearStory } = {}) => {
    const room = getRoom(roomId);
    if (!room) return;
    room.revealed = false;
    if (clearStory) room.story = '';
    // clear all votes
    Object.values(room.users).forEach(u => u.vote = null);
    io.to(roomId).emit('room_state', roomStatePublic(room));
  });

  socket.on('disconnect', () => {
    if (!currentRoomId) return;
    const room = getRoom(currentRoomId);
    if (!room) return;
    delete room.users[socket.id];
    io.to(currentRoomId).emit('room_state', roomStatePublic(room));
  });


// 🎉 FUN: throw items (emojis) that animate on all clients
// 🎯 Throw with side (left/right)
socket.on('throw', ({ roomId, item, side } = {}, ack) => {
  if (!roomId) return;
  const payload = {
    id: nanoid(6),
    item: String(item || '🎉'),
    side: side === 'right' ? 'right' : 'left',  // default left
    s1: Math.random(), // seeds for trajectory
    s2: Math.random(),
  };
  io.to(roomId).emit('throw', payload);
  ack?.({ ok: true });
});

});

// --- Serve built client (single-port prod) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

app.use(express.static(CLIENT_DIST));
app.get('*', (_, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});