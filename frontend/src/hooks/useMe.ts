import { useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { makeTokenGetter, fetchMe, type MeResponse } from '../api/client';

export function useMe() {
  const { getAccessTokenSilently, isAuthenticated } = useAuth0();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    (async () => {
      try {
        const getToken = makeTokenGetter(getAccessTokenSilently);
        const result = await fetchMe(getToken);
        if (!cancelled) setMe(result);
      } catch (error) {
        console.error('Error loading files API permissions:', error);
        if (!cancelled) setMe({ permissions: [] });
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [getAccessTokenSilently, isAuthenticated]);

  // Only the Admin role carries files:delete — see legacy isAdminUser().
  const isAdmin = Array.isArray(me?.permissions) && me.permissions.includes('files:delete');

  return { me, isAdmin, loading };
}
