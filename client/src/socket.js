import { io } from 'socket.io-client';

// If SAME-ORIGIN deploy (single-port), this resolves to the page origin.
// If GitHub Pages (split hosting), build with VITE_SERVER_URL=https://your-server.onrender.com
const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4000');

export const socket = io(SERVER_URL, {
  withCredentials: false,
  transports: ['websocket']
});