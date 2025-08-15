"use client";

import { useEffect, useRef, useState } from "react";

type NarrateInput = {
  symbol: string;
  price?: number;
  float?: number;
  relVol?: number;
  thesis?: string;
};

type Props = {
  input: NarrateInput;
  /** Change this key to auto-regenerate & auto-speak (e.g., when a new trade opens) */
  autoRunKey?: string | number;
  className?: string;
};

export default function TradeNarrator({ input, autoRunKey, className }: Props) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "speaking" | "paused">(
    "idle"
  );
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const speakUtterance = useRef<SpeechSynthesisUtterance | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel();
    };
  }, []);

  // Auto-run when key changes
  useEffect(() => {
    if (autoRunKey == null) return;
    generate(true); // true => also speak
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRunKey]);

  async function generate(andSpeak = false) {
    setError(null);
    setText("");
    setStatus("loading");

    try {
      const res = await fetch("/api/trade-narrate/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok || !res.body) throw new Error(`API ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        full += chunk;
        setText((prev) => {
          const next = prev + chunk;
          // keep view scrolled
          queueMicrotask(() =>
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
          );
          return next;
        });
      }

      setStatus("ready");
      if (andSpeak) speak(full);
    } catch (e: any) {
      setError(e?.message || "Failed to generate narration");
      setStatus("idle");
    }
  }

  function speak(content?: string) {
    const toSpeak = (content ?? text).trim();
    if (!toSpeak) return;
    window.speechSynthesis?.cancel();
    const u = new SpeechSynthesisUtterance(toSpeak);
    u.rate = 1.02;
    u.onend = () => setStatus("ready");
    speakUtterance.current = u;
    window.speechSynthesis?.speak(u);
    setStatus("speaking");
  }

  function pause() {
    window.speechSynthesis?.pause();
    setStatus("paused");
  }
  function resume() {
    window.speechSynthesis?.resume();
    setStatus("speaking");
  }
  function stop() {
    window.speechSynthesis?.cancel();
    setStatus("ready");
  }

  const playClick = async () => {
    if (status === "speaking") return pause();
    if (!text) return generate(true);
    if (status === "paused") return resume();
    speak();
  };

  return (
    <div className={`rounded-2xl border bg-white shadow-sm p-4 md:p-6 ${className || ""}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-gray-600">
          <span className="font-semibold text-gray-900">AI Trade Narrator</span> · {input.symbol}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={playClick}
            className="rounded-xl bg-black text-white px-3 py-1.5 text-sm hover:opacity-90"
          >
            {status === "speaking" ? "Pause" : "Play"}
          </button>
          <button onClick={stop} className="rounded-xl border px-3 py-1.5 text-sm hover:bg-gray-50">
            Stop
          </button>
          <button
            onClick={() => generate(false)}
            className="rounded-xl border px-3 py-1.5 text-sm hover:bg-gray-50"
            disabled={status === "loading"}
          >
            {status === "loading" ? "Thinking…" : "Regenerate"}
          </button>
          <button
            onClick={() => navigator.clipboard.writeText(text)}
            className="rounded-xl border px-3 py-1.5 text-sm hover:bg-gray-50"
          >
            Copy
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="mt-4 h-56 overflow-auto rounded-xl border bg-gray-50 p-4 text-sm leading-6"
      >
        {!text && status === "loading" && (
          <div className="text-gray-600">
            <span className="animate-pulse">
              AI thinking… scanning float, rel vol, VWAP, and key levels.
            </span>
          </div>
        )}
        {text && <pre className="whitespace-pre-wrap text-gray-800">{text}</pre>}
        {error && <div className="text-red-600">{error}</div>}
        {!text && status === "idle" && !error && (
          <div className="text-gray-500">
            Press <b>Play</b> to hear the AI explain entries, exits, and risk.
          </div>
        )}
      </div>

      <div className="mt-3 text-xs text-gray-500">
        Tip: pass <code>float</code>, <code>relVol</code>, or a short <code>thesis</code> for sharper explanations.
      </div>
    </div>
  );
}
