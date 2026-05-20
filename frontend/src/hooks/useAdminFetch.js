/**
 * Safe async data fetching hook for admin components.
 * - Prevents setState after unmount
 * - Always validates response type before setting state
 * - Exposes loading/error state
 */
import { useState, useEffect, useRef, useCallback } from 'react';

export function useAdminFetch(fetchFn, defaultValue, deps = []) {
  const [data, setData]       = useState(defaultValue);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const mountedRef            = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchFn();
      if (!mountedRef.current) return;
      // Validate type matches default
      if (Array.isArray(defaultValue) && !Array.isArray(result)) {
        setData(defaultValue);
      } else if (defaultValue !== null && typeof defaultValue === 'object' && !Array.isArray(defaultValue) && (typeof result !== 'object' || Array.isArray(result) || result === null)) {
        setData(defaultValue);
      } else {
        setData(result);
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e.message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, deps);

  useEffect(() => { load(); }, [load]);

  return { data, loading, error, reload: load, setData };
}
