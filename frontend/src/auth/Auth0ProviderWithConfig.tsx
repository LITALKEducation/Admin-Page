import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Auth0Provider, type AppState } from '@auth0/auth0-react';
import { AUTH0_DOMAIN, AUTH0_CLIENT_ID, FILES_API_AUDIENCE } from '../config';

// A single fixed callback URL (the app's base path) — this must be
// registered in the Auth0 application's Allowed Callback / Logout URLs.
export const AUTH0_REDIRECT_URI = `${window.location.origin}/app/`;

export default function Auth0ProviderWithConfig({ children }: { children: ReactNode }) {
  const navigate = useNavigate();

  const onRedirectCallback = (appState?: AppState) => {
    navigate(appState?.returnTo || '/', { replace: true });
  };

  return (
    <Auth0Provider
      domain={AUTH0_DOMAIN}
      clientId={AUTH0_CLIENT_ID}
      authorizationParams={{
        redirect_uri: AUTH0_REDIRECT_URI,
        audience: FILES_API_AUDIENCE,
        // Spelled out rather than left to the SDK's implicit default. The
        // session only survives a reload because of offline_access — without
        // it Auth0 issues no refresh token, and every visit is a fresh login.
        scope: 'openid profile email offline_access',
      }}
      cacheLocation="localstorage"
      useRefreshTokens
      // The SDK defaults this to false, which means "no refresh token" is a
      // dead end and the user is bounced to the login screen. With it on, the
      // SDK falls back to a silent /authorize in a hidden iframe, which keeps
      // the session alive on any browser that still allows the Auth0 session
      // cookie there. Safari's tracking prevention blocks that iframe, so this
      // is a safety net rather than the fix — the fix is Allow Offline Access
      // on the API, see worker/README.md.
      useRefreshTokensFallback
      onRedirectCallback={onRedirectCallback}
    >
      {children}
    </Auth0Provider>
  );
}
