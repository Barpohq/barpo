import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// In the dev server the backend (platform-server, :8787 by default) is reached
// through a proxy — which is why the UI code never writes an absolute address;
// `/api/...` and `/ws` are enough. In production both come out of the same
// process, so the paths do not change.
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:8787'

// The version comes from the WORKSPACE ROOT package.json — a single source of
// truth. The header used to display a hardcoded "v0.1-demo", which stayed
// frozen at whatever was typed there while releases moved on.
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND.replace(/^http/, 'ws'), ws: true },
    },
  },
})
