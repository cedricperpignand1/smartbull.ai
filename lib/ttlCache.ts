// app/lib/ttlCache.ts
type Entry<T> = { value: T | null; expiresAt: number; inflight?: Promise<T> };

export function createTTLCache<T>(defaultTTLms = 60_000) {
  const store = new Map<string, Entry<T>>();
  const now = () => Date.now();
  const isFresh = (e?: Entry<T> | null) => !!e && e.expiresAt > now() && e.value !== null;

  return {
    get(key: string): T | null {
      const e = store.get(key) || null;
      return isFresh(e) ? (e!.value as T) : null;
    },
    set(key: string, value: T, ttlMs = defaultTTLms): void {
      store.set(key, { value, expiresAt: now() + ttlMs });
    },
    clear(): void { store.clear(); },

    async getOrSet(
      key: string,
      fetcher: () => Promise<T>,
      ttlMs = defaultTTLms
    ): Promise<T> {
      const e = store.get(key) || null;
      if (isFresh(e)) return e!.value as T;     // fresh cache
      if (e?.inflight) return e.inflight;       // share in-flight fetch

      const p = (async () => {
        const v = await fetcher();
        store.set(key, { value: v, expiresAt: now() + ttlMs });
        return v;
      })();

      store.set(key, { value: e?.value ?? null, expiresAt: e?.expiresAt ?? 0, inflight: p });

      try { return await p; }
      finally {
        const cur = store.get(key);
        if (cur) delete cur.inflight;
      }
    },
  };
}
