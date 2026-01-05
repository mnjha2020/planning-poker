import React, { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';

const DEFAULT_DECK = ['0','1','2','3','5','8','13','21','34','55','?','☕'];

function getClientId() {
  const k = 'pp_client_id';
  let v = localStorage.getItem(k);
  if (!v) {
    v = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
    localStorage.setItem(k, v);
  }
  return v;
}


const CLIENT_ID = getClientId();

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL || window.location.origin;

const socket = io(SERVER_URL, {
  transports: ['websocket'], // 🔴 critical for Render stability
  reconnectionAttempts: 10,
  reconnectionDelay: 800,
});

export default function App() {
  const [connected, setConnected] = useState(socket.connected);
  const [roomId, setRoomId] = useState('');
  const [name, setName] = useState(localStorage.getItem('pp_name') || '');
  const [isHost, setIsHost] = useState(false);
  const [spectator, setSpectator] = useState(false);

  const [deck, setDeck] = useState(DEFAULT_DECK);
  const [story, setStory] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [users, setUsers] = useState({});
  const [revealResult, setRevealResult] = useState(null);
  const [throws, setThrows] = useState([]);

  useEffect(() => {
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('room_state', rs => {
      setDeck(rs.deck);
      setStory(rs.story);
      setRevealed(rs.revealed);
      setUsers(rs.users);
      if (!rs.revealed) setRevealResult(null);
    });

    socket.on('reveal_result', payload => {
      setRevealed(true);
      setRevealResult(payload);
    });

    socket.on('throw', payload => {
      setThrows(t => [...t, payload]);
      setTimeout(
        () => setThrows(t => t.filter(e => e.id !== payload.id)),
        1200
      );
    });

    return () => socket.removeAllListeners();
  }, []);

  const createRoom = async () => {
    if (!name.trim()) return alert('Enter name');
    localStorage.setItem('pp_name', name.trim());

    const res = await fetch(`${SERVER_URL}/api/rooms`, { method: 'POST' });
    const { roomId } = await res.json();

    localStorage.setItem(`pp_host_${roomId}`, '1');
    setIsHost(true);
    setRoomId(roomId);

    joinRoom(roomId, true);
  };

  const joinRoom = (rid = roomId, host = false) => {
    if (!name.trim()) return alert('Enter name');
    localStorage.setItem('pp_name', name.trim());

    socket.emit(
      'join_room',
      {
        roomId: rid,
        name: name.trim(),
        asHost: host,
        asSpectator: spectator,
        clientId: CLIENT_ID,
      },
      ack => {
        if (!ack?.ok) alert(ack?.error || 'Join failed');
      }
    );
  };

  const castVote = v => {
    if (spectator) return;
    socket.emit('cast_vote', { roomId, value: v });
  };

  const reveal = () => socket.emit('reveal', { roomId });
  const reset = () => socket.emit('reset', { roomId });

  const throwAt = (cid, emoji) => {
    const el = document.querySelector(`[data-user="${cid}"]`);
    const side =
      el && el.getBoundingClientRect().left > window.innerWidth / 2
        ? 'right'
        : 'left';

    socket.emit('throw', {
      roomId,
      item: emoji,
      targetId: cid,
      side,
    });
  };

  return (
    <div className="container">
      <header className="card row space">
        <strong>🃏 Planning Poker</strong>
        <span className="badge">{connected ? 'Online' : 'Offline'}</span>
      </header>

      <div className="card">
        <div className="row gap">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Your name"
            style={{ maxWidth: 280 }}
          />

          <label className="row gap">
            <input
              type="checkbox"
              checked={spectator}
              onChange={e => setSpectator(e.target.checked)}
            />
            Spectator
          </label>

          <button className="primary" onClick={createRoom}>
            Create Room
          </button>
        </div>

        <div className="row gap" style={{ marginTop: 10 }}>
          <input
            placeholder="Room ID"
            value={roomId}
            onChange={e => setRoomId(e.target.value)}
            style={{ maxWidth: 220 }}
          />
          <button onClick={() => joinRoom(roomId, false)}>Join</button>
        </div>
      </div>

      {roomId && (
        <div className="card">
          <div className="row gap">
            <input
              value={story}
              onChange={e => setStory(e.target.value)}
              placeholder="Story / ticket"
            />
          </div>

          <div className="row gap" style={{ marginTop: 10 }}>
            {isHost && !revealed && (
              <button className="primary" onClick={reveal}>
                Reveal
              </button>
            )}
            {isHost && revealed && (
              <button className="primary" onClick={reset}>
                Reset
              </button>
            )}
            {!isHost && <span className="badge">Waiting…</span>}
          </div>

          {revealResult && (
            <div className="badge" style={{ marginTop: 8 }}>
              Average: {revealResult.average ?? '—'}
            </div>
          )}
        </div>
      )}

      {roomId && (
        <div className="card">
          <h4>Participants</h4>
          <div className="users">
            {Object.entries(users).map(([cid, u]) => (
              <div
                key={cid}
                data-user={cid}
                className={`user ${
                  u.spectator
                    ? 'spectator'
                    : u.voted
                    ? 'voted'
                    : 'not-voted'
                }`}
              >
                <div className="hover-actions">
                  {['🎯','🎉','🚀','💗'].map(e => (
                    <button key={e} onClick={() => throwAt(cid, e)}>
                      {e}
                    </button>
                  ))}
                </div>

                <strong>{u.name}</strong>
                <div className="badge">
                  {u.spectator
                    ? 'Spectator'
                    : revealed
                    ? revealResult?.votes.find(v => v.id === cid)?.vote ?? '—'
                    : u.voted
                    ? 'Voted'
                    : 'Not voted'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {roomId && !spectator && (
        <div className="card">
          <h4>Pick a card</h4>
          <div className="deck">
            {deck.map(v => (
              <button key={v} onClick={() => castVote(v)}>
                {v}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="throw-layer">
        {throws.map(t => (
          <div key={t.id} className="throw">
            {t.item}
          </div>
        ))}
      </div>
    </div>
  );
}
