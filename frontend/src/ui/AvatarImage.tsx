import { useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { apiFetchBlob, makeTokenGetter } from '../api/client';
import { studentInitials } from '../utils/csv';

// Fetches a profile photo through the authenticated /avatar route and
// renders it as a blob URL, falling back to initials if none is set.
export default function AvatarImage({
  path,
  name,
  className,
}: {
  path: string;
  name?: string;
  className?: string;
}) {
  const { getAccessTokenSilently } = useAuth0();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setLoading(true);
    setUrl(null);
    (async () => {
      try {
        const getToken = makeTokenGetter(getAccessTokenSilently);
        const blob = await apiFetchBlob(getToken, path);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        // no avatar uploaded yet — fall back to initials below
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, getAccessTokenSilently]);

  if (loading) return <i className="fas fa-spinner fa-spin"></i>;
  if (url) return <img src={url} alt="รูปโปรไฟล์" className={className} />;
  return name ? <>{studentInitials(name)}</> : <i className="fas fa-user"></i>;
}
