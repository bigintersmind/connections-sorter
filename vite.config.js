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
          if (!(err instanceof PuzzleError)) console.error(`[puzzle] dev middleware error: ${err?.message ?? err}`)
          res.statusCode = err instanceof PuzzleError ? err.status : 502
          res.end(JSON.stringify({ error: err instanceof PuzzleError ? err.code : 'upstream_error' }))
        }
      })
    },
  }
}

// Preloads the tile font's latin subset from <head>, so the bytes are in
// before the bundle has even finished arriving. Without it the @font-face is
// discovered when the stylesheet parses and the file requested only when the
// first React render lays out text in it — two round-trips late — and every
// tile is fitted against the fallback face first and re-fitted (visibly, on a
// cold cache) when Libre Franklin lands. The tag can't simply live in
// index.html because Vite hashes the asset's filename; this looks the emitted
// file up in the bundle. In dev it points at the node_modules path the
// stylesheet itself resolves to, so the preload is exercised there too. Only
// latin: latin-ext (accented tiles) stays lazy behind its unicode-range.
function preloadTileFont() {
  const LATIN = /libre-franklin-latin-wght-normal.*\.woff2$/
  const DEV_HREF = '/node_modules/@fontsource-variable/libre-franklin/files/libre-franklin-latin-wght-normal.woff2'
  let base = '/'
  return {
    name: 'preload-tile-font',
    configResolved(config) {
      base = config.base
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        let href = DEV_HREF
        if (ctx.bundle) {
          const asset = Object.keys(ctx.bundle).find((file) => LATIN.test(file))
          if (!asset) throw new Error('preload-tile-font: latin woff2 not found in the bundle')
          href = base + asset
        }
        return [
          {
            tag: 'link',
            attrs: { rel: 'preload', as: 'font', type: 'font/woff2', crossorigin: true, href },
            injectTo: 'head-prepend',
          },
        ]
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), devPuzzleApi(), preloadTileFont()],
})
