// src/lib/cache.ts
type CacheEntry<T> = { data: T; expiresAt: number };
type InFlightMap = Map<string, Promise<any>>;

const DEFAULT_TTL_MS = 5_000; // 5s
const store = new Map<string, CacheEntry<any>>();
const inFlight: InFlightMap = new Map();

/** Build a stable cache key from URL + options you care about */
export function makeKey(url: string, opts?: Record<string, any>) {
  return opts ? `${url}::${JSON.stringify(opts)}` : url;
}

/** Fetch wrapper with short TTL cache and request de-duplication */
export async function fetchWithCache<T = any>(
  url: string,
  ttlMs: number = DEFAULT_TTL_MS,
  init?: RequestInit
): Promise<T> {
  const key = makeKey(url, init && { method: init.method, body: init.body });

  // 1) Serve fresh cache if valid
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data as T;

  // 2) If another request is already fetching this key, await it
  if (inFlight.has(key)) return (await inFlight.get(key)) as T;

  // 3) Perform the fetch (single flight)
  const p = (async () => {
    const res = await fetch(url, { cache: "no-store", ...init });
    if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as T;

    // 4) Save to cache
    store.set(key, { data, expiresAt: Date.now() + ttlMs });
    return data;
  })();

  inFlight.set(key, p);
  try {
    return await p;
  } finally {
    inFlight.delete(key);
  }
}

/** Optional: manual invalidation */
export function invalidate(key: string) {
  store.delete(key);
}

/** Optional: clear everything */
export function clearCache() {
  store.clear();
}
