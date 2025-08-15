import { useEffect, useRef } from "react";

type Opts = {
  /** ms between polls when visible */
  intervalMs?: number;
  /** optional: element to watch for on-screen visibility */
  container?: React.RefObject<HTMLElement | null>;
};

/**
 * Calls `fn` on an interval, but pauses when:
 * - the tab is hidden, or
 * - the container is off-screen (if provided),
 * and resumes when visible again. Also avoids overlapping fetches.
 */
export function useSmartPolling(fn: () => Promise<void> | void, opts: Opts = {}) {
  const { intervalMs = 5000, container } = opts;
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const inFlight = useRef(false);
  const isContainerVisible = useRef(true); // default true if no container

  // Start/stop the interval safely
  const start = () => {
    if (timerRef.current) return;
    timerRef.current = setInterval(async () => {
      if (document.hidden) return;
      if (!isContainerVisible.current) return;
      if (inFlight.current) return; // avoid overlap
      inFlight.current = true;
      try { await fn(); } finally { inFlight.current = false; }
    }, intervalMs);
  };
  const stop = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  // Run once immediately when visible (no overlap)
  const runNowIfVisible = async () => {
    if (document.hidden) return;
    if (!isContainerVisible.current) return;
    if (inFlight.current) return;
    inFlight.current = true;
    try { await fn(); } finally { inFlight.current = false; }
  };

  useEffect(() => {
    // Page/tab visibility
    const onVis = () => {
      if (document.hidden) {
        stop();
      } else {
        start();
        void runNowIfVisible();
      }
    };
    document.addEventListener("visibilitychange", onVis);

    // Panel visibility (optional)
    let observer: IntersectionObserver | null = null;
    if (container?.current) {
      observer = new IntersectionObserver(
        ([entry]) => {
          isContainerVisible.current = !!entry?.isIntersecting;
          if (!isContainerVisible.current) {
            stop();
          } else {
            start();
            void runNowIfVisible();
          }
        },
        { threshold: 0.1 }
      );
      observer.observe(container.current);
    } else {
      // if no container passed, assume visible
      isContainerVisible.current = true;
    }

    // kick things off
    start();
    void runNowIfVisible();

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (observer) observer.disconnect();
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, container]);
}
