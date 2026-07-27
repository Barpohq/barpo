import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev serverda backend (platform-server, default :8787) proxy orqali ulanadi —
// shu sabab UI kodida absolut manzil yozilmaydi, `/api/...` va `/ws` yetadi.
// Prodda ikkalasi bitta jarayondan chiqadi, ya'ni yo'llar o'zgarmaydi.
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
