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
  const [roomId, setRoomId] = useState(() => {
    try { return decodeURIComponent(window.location.hash.slice(1)); } catch (e) { return ''; }
  });
  const [myName, setMyName] = useState(localStorage.getItem('pp_name') || '');
  const [isHost, setIsHost] = useState(false);
  const [asSpectator, setAsSpectator] = useState(false);

  const [story, setStory] = useState('');
  const [deck, setDeck] = useState(DEFAULT_DECK);
  const [revealed, setRevealed] = useState(false);
  const [users, setUsers] = useState({});
  const [revealResult, setRevealResult] = useState(null);

  const [throws, setThrows] = useState([]);
  // track local selected card so the UI can show which card *you* picked
  const [myVote, setMyVote] = useState(null);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('pp_theme');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch (e) {}
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('pp_theme', theme); } catch (e) {}
  }, [theme]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2200);
  };

  useEffect(() => {
    const onConnect = () => {
      setConnected(true);
      // If we were in a room before disconnect, attempt to re-join so the server
      // can re-associate the new socket id with our stable client id. This
      // helps immediately restore presence after transient network blips.
      if (roomId && myName) {
        const wasHost = !!localStorage.getItem('pp_host_' + roomId);
        // re-join using known client id
        join(roomId, wasHost, asSpectator);
      }
    };
    const onDisconnect = () => setConnected(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    socket.on('room_state', (rs) => {
      setDeck(rs.deck);
      setStory(rs.story);
      setRevealed(rs.revealed);
      setUsers(rs.users);
      if (!rs.revealed) {
        setRevealResult(null);
        // clear local vote only when the server says we haven't voted (new round),
        // not every time someone else's vote triggers a state update
        if (!rs.users?.[CLIENT_ID]?.voted) setMyVote(null);
      }

      // keep host flag if stored locally
      if (roomId && localStorage.getItem('pp_host_' + roomId)) setIsHost(true);
    });

    socket.on('reveal_result', (payload) => {
      setRevealed(true);
      setRevealResult(payload);
      // keep the local myVote (so user still sees what they picked) — no-op
    });

    // throws land on target clientId using DOM
    socket.on('throw', (payload) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const targetEl = payload.targetId ? document.querySelector(`.seat[data-sid="${payload.targetId}"]`) : null;

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
    if (!myName.trim()) { setError('Please enter a display name to continue.'); return; }
    const res = await fetch(api('/api/rooms'), { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const { roomId: rid } = await res.json();
    // creator always becomes host (spectator only toggles voting preference)
    localStorage.setItem('pp_host_' + rid, '1');
    setIsHost(true);
    setRoomId(rid);
    join(rid, true, asSpectator);
  };

  const join = (rid = roomId, asHost = false, spectator = asSpectator) => {
    if (!myName.trim()) { setError('Please enter a display name to continue.'); return; }
    setError('');
    localStorage.setItem('pp_name', myName.trim());
    socket.emit('join_room', { roomId: rid, name: myName.trim(), asHost, asSpectator: spectator, clientId: CLIENT_ID }, (ack) => {
      if (!ack?.ok) {
        if (ack?.error === 'NAME_TAKEN') return setError('That name is already in use in this room. Pick a different one.');
        if (ack?.error === 'EMPTY_NAME') return setError('Please enter a display name.');
        if (ack?.error === 'ROOM_NOT_FOUND') return setError('Room not found. Check the room ID.');
        return setError(`Unable to join room${ack?.error ? `: ${ack.error}` : ''}`);
      }
      try { window.history.replaceState(null, '', `#${encodeURIComponent(rid)}`); } catch (e) {}
      // server may have returned confirmed clientId
      if (ack.clientId) {
        try { localStorage.setItem('pp_clientId', ack.clientId); } catch(e) {}
      }
    });
  };

  // wrapper that also updates local UI state immediately
  const castWithLocal = (value) => {
    if (!roomId) return;
    setMyVote(value);
    socket.emit('cast_vote', { roomId, value });
  };
  const doReveal = () => socket.emit('reveal', { roomId });
  const doReset = () => {
    if (!isHost) return; // only host can reset
    if (!confirm('Are you sure you want to reset the votes?')) return;
    socket.emit('reset', { roomId });
    // local state cleared optimistically
    setMyVote(null);
  };
  const updateStory = () => { socket.emit('set_story', { roomId, story }); showToast('Story updated'); };
  const copyInvite = async () => {
    const link = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(roomId)}`;
    try { await navigator.clipboard.writeText(link); showToast('Invite link copied ✓'); }
    catch (err) { showToast('Could not copy — copy the room ID manually'); }
  };

  // target clientId so throws land on that participant
  const throwAt = (targetId, item) => {
    if (!roomId) return;
    const el = document.querySelector(`.seat[data-sid="${targetId}"]`);
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

  const me = users[CLIENT_ID];
  const inRoom = !!roomId && !!me;
  const iAmSpectator = !!me?.spectator;

  // vote lookup + summary stats derived from the revealed payload
  const voteById = useMemo(() => {
    const m = {};
    (revealResult?.votes || []).forEach(e => { m[e.id] = e.vote; });
    return m;
  }, [revealResult]);

  const summary = useMemo(() => {
    if (!revealResult) return null;
    const cast = revealResult.votes.map(e => e.vote).filter(v => v !== null && v !== undefined);
    if (!cast.length) return { total: 0 };
    const counts = {};
    cast.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
    const idx = (v) => { const i = deck.indexOf(v); return i === -1 ? 999 : i; };
    const dist = Object.entries(counts).sort((a, b) => idx(a[0]) - idx(b[0]) || a[0].localeCompare(b[0], undefined, { numeric: true }));
    const topCount = Math.max(...dist.map(([, c]) => c));
    const modes = dist.filter(([, c]) => c === topCount).map(([v]) => v);
    const nums = cast.map(parseFloat).filter(Number.isFinite);
    const avg = revealResult.average;
    return {
      total: cast.length,
      numCount: nums.length,
      dist,
      topCount,
      modes,
      average: avg === null || avg === undefined ? null : Math.round(avg * 10) / 10,
      min: nums.length ? Math.min(...nums) : null,
      max: nums.length ? Math.max(...nums) : null,
      consensus: cast.length > 1 && dist.length === 1,
    };
  }, [revealResult, deck]);

  const entries = Object.entries(users);
  const voters = entries.filter(([, u]) => !u.spectator);
  const votedCount = voters.filter(([, u]) => u.voted).length;
  const waitingNames = voters.filter(([, u]) => !u.voted).map(([, u]) => u.name).slice(0, 2);
  const everyoneVoted = voters.length > 0 && votedCount === voters.length;

  const AVATAR_COLORS = ['#9fd8d0', '#a9c9e8', '#c9d8a8', '#f3dca0', '#f0b9b0', '#c9b8e0'];
  const avatarColor = (cid) => {
    let h = 0;
    for (const ch of cid) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  };
  const initials = (n) => n.replace(/\(.*\)/, '').trim().slice(0, 2).toUpperCase();

  const isOutlier = (vote) => {
    if (!summary?.dist || summary.numCount < 3 || summary.modes.includes(String(vote))) return false;
    const a = deck.indexOf(String(vote));
    const b = deck.indexOf(summary.modes[0]);
    return a !== -1 && b !== -1 && Math.abs(a - b) >= 2;
  };

  const renderSeat = ([cid, u]) => {
    const vote = revealed ? voteById[cid] : null;
    const hasVote = vote !== null && vote !== undefined;
    const flipped = revealed && hasVote;
    let back;
    if (u.spectator) back = <div className="face back spec">👁</div>;
    else if (revealed ? hasVote : u.voted) back = <div className="face back voted" />;
    else back = <div className="face back empty">…</div>;
    const frontCls = hasVote
      ? (isOutlier(vote) ? ' outlier' : (summary?.dist && summary.total > 1 && summary.modes.includes(String(vote))) ? ' mode' : '')
      : '';
    return (
      <div className="seat" tabIndex={0} key={cid} data-sid={cid}>
        <div className="throwbar">
          {['🎯','✈️','🧻','💗','🎉','🎈','🚀','🥳'].map(em => (
            <button key={em} onClick={() => throwAt(cid, em)} title="Throw" aria-label={`Throw ${em} at ${u.name}`}>{em}</button>
          ))}
        </div>
        <div className={`pcard${flipped ? ' flipped' : ''}`}>
          <div className="pcard-inner">
            {back}
            <div className={`face front${frontCls}`}>{hasVote ? vote : ''}</div>
          </div>
        </div>
        <div className="who">
          <span className="avatar" style={{ background: avatarColor(cid) }}>{initials(u.name)}</span>
          <span className="name">{u.name}{cid === CLIENT_ID ? ' (you)' : ''}</span>
          {u.host && <span className="crown" title="Host">👑</span>}
        </div>
      </div>
    );
  };

  return (
    <>
      <header className="topbar">
        <div className="brand"><div className="logo">PP</div> Planning Poker</div>
        <div className="topbar-right">
          <div className="status">
            <span className={`dot${connected ? '' : ' wait'}`} />
            <span>{connected ? 'Connected' : 'Connecting (server may be waking)…'}</span>
          </div>
          <button
            className="icon-btn"
            onClick={() => setTheme(th => (th === 'dark' ? 'light' : 'dark'))}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label="Toggle dark mode"
          >{theme === 'dark' ? '☀️' : '🌙'}</button>
        </div>
      </header>

      <main>
        {!inRoom ? (
          /* LOBBY */
          <section className="view">
            <div className="panel lobby">
              <div className="hero-cards"><span>3</span><span>5</span><span>8</span></div>
              <h1>Estimate together</h1>
              <p className="sub">Vote privately, reveal at the same time.</p>
              <div className="stack">
                <div>
                  <label className="small" htmlFor="nameIn">Display name</label>
                  <input
                    id="nameIn"
                    className={`field${error ? ' err' : ''}`}
                    placeholder="e.g. Priya"
                    autoComplete="off"
                    value={myName}
                    onChange={e => { setMyName(e.target.value); setError(''); }}
                  />
                  <div className="errmsg" role="alert">{error}</div>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={asSpectator} onChange={e => setAsSpectator(e.target.checked)} />
                  <span className="switch" /> Join as spectator (watch, don't vote)
                </label>
                <button className="btn primary lg" onClick={createRoom}>Create a room</button>
                <div className="divider">or join with a code</div>
                <div className="join-row">
                  <input
                    className="field"
                    placeholder="Room ID"
                    autoComplete="off"
                    value={roomId}
                    onChange={e => { setRoomId(e.target.value.trim()); setError(''); }}
                    onKeyDown={e => { if (e.key === 'Enter') join(roomId, false, asSpectator); }}
                  />
                  <button className="btn" onClick={() => join(roomId, false, asSpectator)}>Join</button>
                </div>
              </div>
            </div>
          </section>
        ) : (
          /* ROOM */
          <section className="view">
            <div className="roombar">
              <div className="roomid">
                <span className="hint">Room</span>
                <span className="chip">{roomId}</span>
                <button className="btn" onClick={copyInvite}>Copy invite link</button>
              </div>
              <div className="story">
                <input
                  className="field"
                  placeholder="Story / ticket (optional)"
                  aria-label="Story"
                  value={story}
                  onChange={e => setStory(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') updateStory(); }}
                />
                <button className="btn" onClick={updateStory}>Set</button>
              </div>
            </div>

            <div className="table"><div className="seats">{entries.map(renderSeat)}</div></div>

            <div className="actions">
              {!revealed && (
                <div className="actions-info">
                  <div className="progress"><i style={{ width: `${voters.length ? (votedCount / voters.length) * 100 : 0}%` }} /></div>
                  <div className="hint">
                    {votedCount} of {voters.length} voted
                    {votedCount < voters.length && waitingNames.length > 0 ? ` · waiting for ${waitingNames.join(', ')}` : ''}
                    {everyoneVoted ? ' · everyone is in!' : ''}
                  </div>
                </div>
              )}
              {!revealed
                ? (isHost
                    ? <button className="btn primary lg" onClick={doReveal}>Reveal cards</button>
                    : <div className="hint">Waiting for the host to reveal…</div>)
                : (isHost
                    ? <button className="btn primary lg" onClick={doReset}>Start new round</button>
                    : <div className="hint">Cards revealed · waiting for the host to start a new round</div>)}
            </div>

            {summary && (
              <div className="results">
                {summary.total === 0 ? (
                  <div className="panel"><div className="banner warn">No votes were cast.</div></div>
                ) : (
                  <>
                    <div className="panel">
                      <div className="stat-row">
                        <div className="stat"><b>{summary.modes.join(' / ')}</b><span>{summary.modes.length > 1 ? 'Most votes (tie)' : 'Most votes'}</span></div>
                        <div className="stat"><b>{summary.average ?? '–'}</b><span>Average</span></div>
                        <div className="stat"><b>{summary.min !== null ? `${summary.min}–${summary.max}` : '–'}</b><span>Range</span></div>
                      </div>
                      {summary.consensus
                        ? <div className="banner ok">Consensus — everyone voted {summary.modes[0]}.</div>
                        : summary.total > 1 && <div className="banner warn">Votes are spread out. Ask the highest and lowest voters to explain their thinking, then re-vote.</div>}
                    </div>
                    <div className="panel">
                      <label className="small">Distribution</label>
                      <div className="bars">
                        {summary.dist.map(([v, c]) => (
                          <div key={v} className={`bar${c === summary.topCount ? ' top' : ''}`}>
                            <b>{v}</b>
                            <div className="track"><i style={{ width: `${(c / summary.total) * 100}%` }} /></div>
                            <span>{c}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
        )}
      </main>

      {inRoom && (
        <div className="tray">
          <div className="tray-in">
            {deck.map(v => (
              <button
                key={v}
                aria-label={`Vote ${v}`}
                className={`dcard${'?☕'.includes(v) ? ' special' : ''}${v === myVote ? ' sel' : ''}`}
                disabled={iAmSpectator}
                onClick={() => castWithLocal(v)}
              >{v}</button>
            ))}
          </div>
        </div>
      )}

      <div className={`toast${toast ? ' show' : ''}`} role="status">{toast}</div>

      {/* overlay for thrown items */}
      <div className="party-layer" aria-hidden="true">
        {throws.map(t => (
          <div key={t.id} className="throwable" style={{ left: 0, top: 0, transform: `translate(${t.style['--x-start']}, ${t.style['--y-start']})`, ...t.style }}>
            {t.img ? <img src={t.img} alt="" className="throw-img" /> : t.item}
          </div>
        ))}
      </div>
    </>
  );
}
