import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import Auth0ProviderWithConfig from './auth/Auth0ProviderWithConfig.tsx'

// HashRouter, not BrowserRouter: GitHub Pages serves static files with no
// server-side rewrite, so a real path like /app/students 404s on refresh
// or a direct link. Routing after the # never reaches the server, so it
// always resolves to /app/index.html regardless of which screen is open.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <Auth0ProviderWithConfig>
        <App />
      </Auth0ProviderWithConfig>
    </HashRouter>
  </StrictMode>,
)
