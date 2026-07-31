import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// In the dev server the backend (platform-server, :8787 by default) is reached
// through a proxy — which is why the UI code never writes an absolute address;
// `/api/...` and `/ws` are enough. In production both come out of the same
// process, so the paths do not change.
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:8787'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND.replace(/^http/, 'ws'), ws: true },
    },
  },
})
