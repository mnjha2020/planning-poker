import React, { useEffect, useMemo, useState } from 'react';
import { socket } from './socket';

// You can keep your preferred deck
const DEFAULT_DECK = ['0','1','2','3','5','8','13','21','34','55','?','☕'];

// SIMPLE helper to get/create clientId in localStorage
function getOrCreateClientId() {
  try {
    const key = 'pp_clientId';
    let id = localStorage.getItem(key);
    if (!id) {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        id = crypto.randomUUID();
      } else {
        // fallback
        id = 'cid-' + Math.random().toString(36).slice(2, 10);
      }
      localStorage.setItem(key, id);
    }
    return id;
  } catch (e) {
    // localStorage might be blocked; just return a volatile id
    return 'cid-' + Math.random().toString(36).slice(2, 10);
  }
}

const CLIENT_ID = getOrCreateClientId();

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4000');
const api = (p) => `${SERVER_URL}${p}`;

export default function App() {
  const [connected, setConnected] = useState(socket.connected);
  const [roomId, setRoomId] = useState('');
  const [myName, setMyName] = useState(localStorage.getItem('pp_name') || '');
  const [isHost, setIsHost] = useState(false);
  const [asSpectator, setAsSpectator] = useState(false);

  const [story, setStory] = useState('');
  const [deck, setDeck] = useState(DEFAULT_DECK);
  const [revealed, setRevealed] = useState(false);
  const [users, setUsers] = useState({});
  const [revealResult, setRevealResult] = useState(null);

  const [throws, setThrows] = useState([]);

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    socket.on('room_state', (rs) => {
      setDeck(rs.deck);
      setStory(rs.story);
      setRevealed(rs.revealed);
      setUsers(rs.users);
      if (!rs.revealed) setRevealResult(null);

      // keep host flag if stored locally
      if (roomId && localStorage.getItem('pp_host_' + roomId)) setIsHost(true);
    });

    socket.on('reveal_result', (payload) => {
      setRevealed(true);
      setRevealResult(payload);
    });

    // throws land on target clientId using DOM
    socket.on('throw', (payload) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const targetEl = payload.targetId ? document.querySelector(`.user[data-sid="${payload.targetId}"]`) : null;

      let xEnd = vw * 0.5;
      let yEnd = vh * 0.5;
      if (targetEl) {
        const r = targetEl.getBoundingClientRect();
        xEnd = r.left + r.width / 2;
        yEnd = r.top + r.height / 2;
      }

      const y0 = Math.floor(vh * (0.25 + 0.50 * payload.s1));
      const x0 = payload.side === 'right' ? vw + 64 : -64;
      const x1 = Math.floor((x0 + xEnd) / 2 + (payload.side === 'right' ? -40 : 40));
      const y1 = Math.min(y0, yEnd) - Math.floor(80 + 120 * payload.s2);

      const style = {
        '--x-start': `${x0}px`,
        '--y-start': `${y0}px`,
        '--x-mid': `${x1}px`,
        '--y-mid': `${Math.max(20, y1)}px`,
        '--x-end': `${xEnd}px`,
        '--y-end': `${yEnd}px`,
      };

      setThrows(t => [...t, {
        id: payload.id,
        item: payload.item,
        img: payload.img || null,
        style
      }]);

      setTimeout(() => setThrows(t => t.filter(e => e.id !== payload.id)), 1300);
    });

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('room_state');
      socket.off('reveal_result');
      socket.off('throw');
    };
  }, [roomId]);

  const createRoom = async () => {
    const res = await fetch(api('/api/rooms'), { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const { roomId: rid } = await res.json();
    // creator always becomes host (spectator only toggles voting preference)
    localStorage.setItem('pp_host_' + rid, '1');
    setIsHost(true);
    setRoomId(rid);
    join(rid, true, asSpectator);
  };

  const join = (rid = roomId, asHost = false, spectator = asSpectator) => {
    if (!myName.trim()) { alert('Enter a display name'); return; }
    localStorage.setItem('pp_name', myName.trim());
    socket.emit('join_room', { roomId: rid, name: myName.trim(), asHost, asSpectator: spectator, clientId: CLIENT_ID }, (ack) => {
      if (!ack?.ok) {
        if (ack?.error === 'NAME_TAKEN') return alert('That name is already in use in this room. Pick a different one.');
        if (ack?.error === 'EMPTY_NAME') return alert('Please enter a display name.');
        return alert(`Unable to join room${ack?.error ? `: ${ack.error}` : ''}`);
      }
      // server may have returned confirmed clientId
      if (ack.clientId) {
        try { localStorage.setItem('pp_clientId', ack.clientId); } catch(e) {}
      }
    });
  };

  const cast = (value) => socket.emit('cast_vote', { roomId, value });
  const doReveal = () => socket.emit('reveal', { roomId });
  const doReset = () => socket.emit('reset', { roomId });
  const updateStory = () => socket.emit('set_story', { roomId, story });

  // target clientId so throws land on that participant
  const throwAt = (targetId, item) => {
    if (!roomId) return;
    const el = document.querySelector(`.user[data-sid="${targetId}"]`);
    let side = 'left';
    if (el) {
      const rect = el.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      side = mid < window.innerWidth / 2 ? 'left' : 'right';
    }
    socket.emit('throw', { roomId, side, targetId, item });
  };

  useEffect(() => {
    if (roomId) setIsHost(!!localStorage.getItem('pp_host_' + roomId));
  }, [roomId]);

  const joined = useMemo(() => !!roomId && Object.keys(users).length > 0, [roomId, users]);

  return (
    <div className="container">
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <div>🃏 <strong>Planning Poker</strong></div>
          <div className="badge">{connected ? 'Online' : 'Offline'}</div>
        </div>
      </div>

      {/* Lobby / Controls */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ alignItems: 'center', gap: 12 }}>
          <input
            placeholder="Your display name"
            value={myName}
            onChange={e => setMyName(e.target.value)}
            style={{ flex: '0 1 420px', maxWidth: '420px' }}
          />

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={asSpectator} onChange={e => setAsSpectator(e.target.checked)} />
            <span style={{ fontSize: 14 }}>Spectator</span>
          </label>

          <button className="primary" onClick={createRoom}>Create Room</button>
        </div>

        <div className="row" style={{ marginTop: 12, alignItems: 'center' }}>
          <input
            placeholder="Join room ID"
            value={roomId}
            onChange={e => setRoomId(e.target.value)}
            style={{ flex: '0 1 360px', maxWidth: '360px' }}
          />

          <button onClick={() => join(roomId, false, asSpectator)}>Join</button>

          {roomId && (
            <a className="link" href={`#${roomId}`} onClick={e => { e.preventDefault(); navigator.clipboard.writeText(roomId); }} style={{ marginLeft: 8 }}>
              Copy ID
            </a>
          )}
        </div>
      </div>

      {/* Story & Actions */}
      {roomId && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <input style={{ flex: 1 }} placeholder="Story / ticket (optional)" value={story} onChange={e => setStory(e.target.value)} />
            <button onClick={updateStory}>Set</button>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            {!revealed ? (isHost ? <button className="primary" onClick={doReveal}>Reveal</button> : <span className="badge">Waiting for reveal…</span>)
              : <button className="primary" onClick={doReset}>Reset</button>}
          </div>

          {revealResult && <div style={{ marginTop: 12 }}><div className="badge">Average (numeric only): {revealResult.average ?? '—'}</div></div>}
        </div>
      )}

      {/* Participants */}
      {roomId && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 8 }}>Participants</div>
          <div className="users">
            {Object.entries(users).map(([cid, u]) => (
              <div className={`user ${u.spectator ? 'spectator' : u.voted ? 'voted' : 'not-voted'}`} key={cid} data-sid={cid}>
                <div className="hover-throw" aria-hidden="true">
                  {['🎯','✈️','🧻','💗','🎉','🎈','🚀','🥳'].map(em => (
                    <button key={em} onClick={() => throwAt(cid, em)} title="Throw">{em}</button>
                  ))}
                </div>

                <div><strong>{u.name}</strong></div>
                {!revealed ? (u.spectator ? <div className="badge">Spectator</div> : <div className="badge">{u.voted ? 'Voted' : 'Not yet'}</div>)
                  : <div className="badge">{revealResult?.votes?.find(e => e.id === cid)?.vote ?? (u.spectator ? 'Spectator' : '—')}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Deck */}
      {roomId && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 8 }}>Pick a card{asSpectator ? ' (optional for spectators)' : ''}:</div>
          <div className="deck" style={asSpectator ? { opacity: 0.95 } : undefined}>
            {deck.map(v => (<button key={v} onClick={() => cast(v)}>{v}</button>))}
          </div>
        </div>
      )}

      <div className="footer">Tip: share the Room ID with your team, everyone joins and votes privately until you hit Reveal.</div>

      {/* overlay for thrown items */}
      <div className="party-layer" aria-hidden="true">
        {throws.map(t => (
          <div key={t.id} className="throwable" style={{ left: 0, top: 0, transform: `translate(${t.style['--x-start']}, ${t.style['--y-start']})`, ...t.style }}>
            {t.img ? <img src={t.img} alt="" className="throw-img" /> : t.item}
          </div>
        ))}
      </div>
    </div>
  );
}