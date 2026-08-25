import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted Libre Franklin (the open-source Franklin Gothic that NYT itself
// uses) — bundled by Vite from node_modules, so it's served from our own
// origin with no Google Fonts request. The variable font covers weights
// 100–900 and the latin-ext subset, so accented tiles (e.g. "EL NIÑO") render.
import '@fontsource-variable/libre-franklin'
import './index.css'
import App from './App.jsx'
import { withoutShareMarker } from './share.js'

// A visit through a shared link arrives as /?utm_source=share. Drop the marker
// before the first paint so it doesn't linger in the address bar or ride along
// when this person shares in turn. replaceState: no reload, no history entry.
const cleanHref = withoutShareMarker(location.href)
if (cleanHref) history.replaceState(history.state, '', cleanHref)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
