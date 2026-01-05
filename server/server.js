import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { nanoid } from 'nanoid';

const app = express();
app.use(express.json());
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 4000;

const rooms = new Map();
const socketToClient = new Map();

const DEFAULT_DECK = ['0','1','2','3','5','8','13','21','34','55','?','☕'];

function createRoom() {
  const id = nanoid(8);
  rooms.set(id, {
    id,
    deck: DEFAULT_DECK,
    story: '',
    revealed: false,
    users: {},
  });
  return id;
}

function publicState(room) {
  return {
    id: room.id,
    deck: room.deck,
    story: room.story,
    revealed: room.revealed,
    users: Object.fromEntries(
      Object.entries(room.users).map(([cid, u]) => [
        cid,
        {
          name: u.name,
          voted: u.vote !== null,
          spectator: u.spectator,
          host: u.host,
        },
      ])
    ),
  };
}

function computeReveal(room) {
  const votes = Object.entries(room.users).map(([id, u]) => ({
    id,
    name: u.name,
    vote: u.vote,
  }));
  const nums = votes.map(v => parseFloat(v.vote)).filter(n => !isNaN(n));
  const avg = nums.length ? nums.reduce((a,b)=>a+b,0)/nums.length : null;
  return { votes, average: avg };
}

app.post('/api/rooms', (_, res) => {
  res.json({ roomId: createRoom() });
});

app.get('/health', (_, res) => res.json({ ok: true }));

io.on('connection', socket => {
  socket.on('join_room', (p, ack) => {
    const room = rooms.get(p.roomId);
    if (!room) return ack({ ok: false, error: 'ROOM_NOT_FOUND' });

    const cid = p.clientId || nanoid(6);
    socketToClient.set(socket.id, cid);
    socket.join(p.roomId);

    if (!room.users[cid]) {
      room.users[cid] = {
        name: p.name,
        vote: null,
        spectator: !!p.asSpectator,
        host: !!p.asHost,
      };
    }

    room.revealed = false;
    io.to(p.roomId).emit('room_state', publicState(room));
    ack({ ok: true });
  });

  socket.on('cast_vote', ({ roomId, value }) => {
    const room = rooms.get(roomId);
    const cid = socketToClient.get(socket.id);
    if (!room || !room.users[cid] || room.users[cid].spectator) return;

    room.users[cid].vote = value;
    io.to(roomId).emit('room_state', publicState(room));

    if (room.revealed)
      io.to(roomId).emit('reveal_result', computeReveal(room));
  });

  socket.on('reveal', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.revealed = true;
    io.to(roomId).emit('reveal_result', computeReveal(room));
    io.to(roomId).emit('room_state', publicState(room));
  });

  socket.on('reset', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.revealed = false;
    Object.values(room.users).forEach(u => (u.vote = null));
    io.to(roomId).emit('room_state', publicState(room));
  });

  socket.on('throw', payload => {
    io.to(payload.roomId).emit('throw', {
      ...payload,
      id: nanoid(6),
    });
  });

  socket.on('disconnect', () => {
    socketToClient.delete(socket.id);
  });
});

server.listen(PORT, () =>
  console.log(`Server running on ${PORT}`)
);
