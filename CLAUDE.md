# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Real-time planning poker app: a Node/Express + Socket.IO server (`server/`) and a React + Vite client (`client/`). Both are ESM (`"type": "module"`) with separate `package.json`s — there is no root package.json, and no tests or linter are configured.

## Commands

Server (`cd server`):
- `npm run dev` / `npm start` — run on port 4000 (config via `server/.env`, see `.env.sample`: `PORT`, `CORS_ORIGIN`, optional `RECONNECT_GRACE_MS`)
- `npm run build:client` — builds the client so the server can serve it

Client (`cd client`):
- `npm run dev` — Vite on :5173; proxies `/api` and `/socket.io` to `localhost:4000`, so run the server too
- `npm run build` — `vite build` then `scripts/spa-404.js` (copies `index.html` to `404.html` for GitHub Pages deep links)

## Architecture

**Server (`server/server.js`, single file)** holds all state in an in-memory `rooms` Map (single instance only; no persistence). Rooms are created via `POST /api/rooms` and everything else happens over Socket.IO events: `join_room`, `set_story`, `set_deck`, `cast_vote`, `reveal`, `reset`, `transfer_host`, `throw` (a pass-through fun-animation event). It also serves `client/dist` with an SPA catch-all, enabling single-port production.

Key design points:
- **Users are keyed by a stable `clientId`, not socket id.** The client generates it and stores it in localStorage (`pp_clientId`); each user holds a `Set` of socket ids so multiple tabs/reconnects map to the same user. `socketToClient` maps socket → clientId.
- **Disconnect grace period:** when a user's last socket drops, removal is deferred by `RECONNECT_GRACE_MS` (default 60s) via `removalTimers`; rejoining clears the timer.
- **Vote hiding:** `roomStatePublic` only exposes `voted: boolean`; actual votes are sent only in the `reveal_result` event (`computeRevealPayload`, which also computes the numeric average). Votes cast after reveal re-emit `reveal_result`. A brand-new user joining un-reveals the room; reconnects don't.
- Server emits full `room_state` to the room after every mutation; the client just replaces its state.
- **Host is server-enforced.** `POST /api/rooms` returns a secret `hostToken` (kept in `room.hostToken`, never sent in `room_state`); the creator stores it in localStorage as `pp_hostToken_<roomId>` and presents it on `join_room`. Only a matching token grants host; there is no client `asHost` flag. `reveal`, `reset`, `set_deck` and `transfer_host` check `isHostSocket()` and reply `{ ok: false, error: 'NOT_HOST' }` otherwise. `transfer_host` moves the role and invalidates the token; if the host is removed after the grace period the next non-spectator is promoted. The client reads `users[CLIENT_ID].host` from `room_state` rather than tracking host locally. `set_story` is still open to everyone.

**Client (`client/src/`)**: `app.jsx` is the whole UI (state, socket listeners, join flow); `socket.js` creates the shared Socket.IO client (websocket-only transport, infinite reconnection) using `VITE_SERVER_URL` or falling back to `window.location.origin`. Note `app.jsx` also computes its own server URL near the top.

## Deployment

- Server: Render (`render.yaml`), builds client then installs server deps with `--omit=dev`, starts `node server/server.js`, health check at `/health`. (The YAML indentation in that file appears broken — verify before relying on it.)
- Client: GitHub Pages via `.github/workflows/pages.yml` on push to `main` (note the local branch is `master`). It builds with `VITE_SERVER_URL` pointing at the Render server and `VITE_BASE=/planning-poker/` (project-site base path).
