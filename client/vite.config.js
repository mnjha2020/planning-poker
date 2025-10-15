import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    // For GitHub Pages project sites, set VITE_BASE="/<repo-name>/"
    base: env.VITE_BASE || '/',
    server: {
      host: true,
      port: 5173,
      proxy: {
        '/api': { target: 'http://localhost:4000', changeOrigin: true },
        '/socket.io': { target: 'http://localhost:4000', changeOrigin: true, ws: true }
      }
    }
  };
});