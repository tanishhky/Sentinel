import { useEffect, useState } from "react";

export function useFetch<T>(url: string, intervalMs = 5000): {
  data: T | null;
  error: string | null;
  loading: boolean;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!cancelled) {
          setData(j as T);
          setError(null);
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(String(e?.message ?? e));
          setLoading(false);
        }
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [url, intervalMs]);

  return { data, error, loading };
}
