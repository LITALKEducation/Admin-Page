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
      }}
      cacheLocation="localstorage"
      useRefreshTokens
      onRedirectCallback={onRedirectCallback}
    >
      {children}
    </Auth0Provider>
  );
}
