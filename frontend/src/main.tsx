import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import Auth0ProviderWithConfig from './auth/Auth0ProviderWithConfig.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/app">
      <Auth0ProviderWithConfig>
        <App />
      </Auth0ProviderWithConfig>
    </BrowserRouter>
  </StrictMode>,
)
