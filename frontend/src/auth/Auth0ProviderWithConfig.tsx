import type { ReactNode } from 'react';
import { Auth0Provider, type AppState } from '@auth0/auth0-react';
import { AUTH0_DOMAIN, AUTH0_CLIENT_ID, FILES_API_AUDIENCE } from '../config';

export default function Auth0ProviderWithConfig({ children }: { children: ReactNode }) {
  const onRedirectCallback = (appState?: AppState) => {
    window.history.replaceState({}, document.title, appState?.returnTo || window.location.pathname);
  };

  return (
    <Auth0Provider
      domain={AUTH0_DOMAIN}
      clientId={AUTH0_CLIENT_ID}
      authorizationParams={{
        redirect_uri: window.location.origin + window.location.pathname,
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
