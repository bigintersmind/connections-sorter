import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fetchPuzzleWords, resolvePuzzleDate, PuzzleError } from './worker/puzzle.js'

// Serves GET /api/puzzle during `npm run dev` using the SAME fetch + transform
// logic the Cloudflare Worker runs in production, so the daily-words flow works
// end-to-end locally without needing `wrangler dev`.
function devPuzzleApi() {
  return {
    name: 'dev-puzzle-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost')
        if (url.pathname !== '/api/puzzle') return next()
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'method_not_allowed' }))
          return
        }
        const resolved = resolvePuzzleDate(url.searchParams.get('date'))
        if (resolved.error) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: resolved.error }))
          return
        }
        try {
          const payload = await fetchPuzzleWords(resolved.date)
          res.statusCode = 200
          res.end(JSON.stringify(payload))
        } catch (err) {
          res.statusCode = err instanceof PuzzleError ? err.status : 502
          res.end(JSON.stringify({ error: err instanceof PuzzleError ? err.code : 'upstream_error' }))
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), devPuzzleApi()],
})
