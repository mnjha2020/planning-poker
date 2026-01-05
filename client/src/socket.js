import { io } from 'socket.io-client';

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4000');

export const socket = io(SERVER_URL, {
  withCredentials: false,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,         // Adds jitter to retries (prevents thundering herd)
  timeout: 20000,
  transports: ['websocket'],

  // Optional: upgrade to polling only if websocket fails permanently (rare)
  // upgrade: false,  // Uncomment if you want to *never* fall back to polling

  // Helpful for debugging in dev
  autoConnect: true,  // default is true anyway
});