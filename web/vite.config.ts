import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The build lands in web/dist, which the Go binary embeds. In development,
// `npm run dev` proxies the API, sign-in routes and WebSocket to a Dispatch
// server on :8080, so cookies stay same-origin.
const backend = process.env.DISPATCH_DEV_BACKEND ?? 'http://localhost:8080'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api/ws': { target: backend, ws: true },
      '/api': backend,
      '/auth': backend,
    },
  },
})
