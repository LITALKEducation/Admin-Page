import { useCallback, useEffect, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { makeTokenGetter, fetchStudents, type Student } from '../api/client';

export function useStudents() {
  const { getAccessTokenSilently, isAuthenticated } = useAuth0();
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const getToken = makeTokenGetter(getAccessTokenSilently);
      const result = await fetchStudents(getToken);
      setStudents(result);
      setFailed(false);
    } catch (error) {
      console.error('getStudents error:', error);
      setStudents([]);
      setFailed(true);
    }
    setLoading(false);
  }, [getAccessTokenSilently]);

  useEffect(() => {
    if (!isAuthenticated) return;
    reload();
  }, [isAuthenticated, reload]);

  return { students, loading, failed, reload };
}
