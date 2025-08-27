// lib/getJSON.ts
export async function getJSON<T = any>(path: string, body?: any): Promise<T> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);

  try {
    const res = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${path} -> ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}
