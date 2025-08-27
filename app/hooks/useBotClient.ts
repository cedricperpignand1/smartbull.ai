"use client";

import { useEffect, useState } from "react";

/**
 * Polls the bot/tick endpoint every 5 seconds
 */
export function useBotClient() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let id: NodeJS.Timeout;

    const run = async () => {
      try {
        const r = await fetch("/api/bot/tick", { cache: "no-store" });
        const j = await r.json();
        setData(j);
      } catch (err) {
        console.error("Bot polling error:", err);
      }
      setLoading(false);
    };

    run();
    id = setInterval(run, 5000);

    return () => clearInterval(id);
  }, []);

  return { data, loading };
}
