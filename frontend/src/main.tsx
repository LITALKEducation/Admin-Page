import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import Auth0ProviderWithConfig from './auth/Auth0ProviderWithConfig.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Auth0ProviderWithConfig>
      <App />
    </Auth0ProviderWithConfig>
  </StrictMode>,
)
