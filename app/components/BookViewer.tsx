"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";

export type BookPage = {
  title?: string;
  content: React.ReactNode;
  imageSrc?: string; // optional banner/hero image at top of page
  imageAlt?: string;
};

export default function BookViewer({
  pages,
  className = "",
  initialPage = 0,
  lockAtEnds = true, // if true, disables wrap-around
  height = 540, // base design height; scales with width
}: {
  pages: BookPage[];
  className?: string;
  initialPage?: number;
  lockAtEnds?: boolean;
  height?: number;
}) {
  const [index, setIndex] = useState(
    Math.min(Math.max(initialPage, 0), pages.length - 1)
  );
  const [direction, setDirection] = useState<1 | -1>(1);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Clamp index when pages change
  useEffect(() => {
    setIndex((i) => Math.min(Math.max(i, 0), pages.length - 1));
  }, [pages.length]);

  const atStart = index === 0;
  const atEnd = index === pages.length - 1;

  const canPrev = useMemo(() => !lockAtEnds || !atStart, [lockAtEnds, atStart]);
  const canNext = useMemo(() => !lockAtEnds || !atEnd, [lockAtEnds, atEnd]);

  const go = (dir: 1 | -1) => {
    if (dir === 1) {
      if (atEnd && !lockAtEnds) {
        setDirection(1);
        setIndex(0);
      } else if (!atEnd) {
        setDirection(1);
        setIndex((i) => i + 1);
      }
    } else {
      if (atStart && !lockAtEnds) {
        setDirection(-1);
        setIndex(pages.length - 1);
      } else if (!atStart) {
        setDirection(-1);
        setIndex((i) => i - 1);
      }
    }
  };

  // Keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [atStart, atEnd, lockAtEnds, pages.length]);

  // Simple swipe (touch) navigation
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let startX = 0;
    let dx = 0;

    const onStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      dx = 0;
    };
    const onMove = (e: TouchEvent) => {
      dx = e.touches[0].clientX - startX;
    };
    const onEnd = () => {
      if (Math.abs(dx) > 60) {
        go(dx < 0 ? 1 : -1);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
    };
  }, [atStart, atEnd, lockAtEnds, pages.length]);

  // Framer Motion variants
  const pageVariants = {
    enter: (dir: 1 | -1) => ({
      rotateY: dir === 1 ? 65 : -65,
      opacity: 0,
      x: dir === 1 ? 30 : -30,
    }),
    center: {
      rotateY: 0,
      opacity: 1,
      x: 0,
    },
    exit: (dir: 1 | -1) => ({
      rotateY: dir === 1 ? -65 : 65,
      opacity: 0,
      x: dir === 1 ? -30 : 30,
    }),
  };

  return (
    <div ref={containerRef} className={"mx-auto " + className} aria-label="Interactive book">
      <div className="relative w-full" style={{ aspectRatio: "3 / 4", maxHeight: height }}>
        {/* Book shell */}
        <div className="absolute inset-0 rounded-2xl bg-neutral-900 shadow-2xl ring-1 ring-black/20 overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-white/5 via-transparent to-black/30 pointer-events-none" />

          {/* Subtle spine / pages edge */}
          <div className="absolute left-0 top-0 h-full w-1.5 bg-gradient-to-b from-black/40 via-black/20 to-black/40" />
          <div className="absolute right-0 top-0 h-full w-px bg-white/10" />

          {/* Page area */}
          <div className="relative h-full flex">
            {/* Left gutter */}
            <div className="w-[14px] sm:w-[18px] md:w-[24px] bg-gradient-to-b from-black/20 via-transparent to-black/20" />

            {/* Animated page */}
            <div className="flex-1 relative">
              <AnimatePresence initial={false} custom={direction}>
                <motion.div
                  key={index}
                  custom={direction}
                  variants={pageVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ type: "spring", damping: 24, stiffness: 230, mass: 0.7 }}
                  className="absolute inset-0 [transform-style:preserve-3d]"
                >
                  <div className="absolute inset-0 p-5 sm:p-6 md:p-7 lg:p-8">
                    <article className="h-full w-full rounded-xl bg-[rgba(255,255,255,0.03)] backdrop-blur-sm ring-1 ring-white/10 shadow-inner overflow-auto">
                      {/* Page number */}
                      <div className="sticky top-0 z-10 flex items-center justify-end p-3 text-[11px] uppercase tracking-widest text-white/40">
                        <span>{index + 1} / {pages.length}</span>
                      </div>

                      {/* Optional hero image */}
                      {pages[index]?.imageSrc && (
                        <div className="px-4 pb-2">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={pages[index].imageSrc!}
                            alt={pages[index].imageAlt || pages[index].title || ""}
                            className="w-full h-40 object-cover rounded-lg ring-1 ring-white/10"
                          />
                        </div>
                      )}

                      {/* Title */}
                      {pages[index]?.title && (
                        <h2 className="px-5 pt-2 pb-3 text-xl md:text-2xl font-semibold text-white/90">
                          {pages[index].title}
                        </h2>
                      )}

                      {/* Content */}
                      <div className="prose prose-invert max-w-none px-5 pb-8 leading-relaxed text-white/85">
                        {pages[index]?.content}
                      </div>
                    </article>
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Right gutter */}
            <div className="w-[14px] sm:w-[18px] md:w-[24px] bg-gradient-to-b from-black/20 via-transparent to-black/20" />
          </div>

          {/* Nav controls */}
          <div className="absolute inset-x-0 bottom-2 sm:bottom-3 md:bottom-4 flex items-center justify-between px-3 sm:px-4 md:px-6">
            <button
              onClick={() => go(-1)}
              disabled={!canPrev}
              className="group inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-white/80 hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-white/30"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Previous</span>
            </button>

            <div className="text-xs sm:text-sm text-white/60 select-none">
              Press ← / → or swipe
            </div>

            <button
              onClick={() => go(1)}
              disabled={!canNext}
              className="group inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-white/80 hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-white/30"
              aria-label="Next page"
            >
              <span className="hidden sm:inline">Next</span>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Dots */}
      <div className="mt-3 flex items-center justify-center gap-2">
        {pages.map((_, i) => (
          <button
            key={i}
            onClick={() => {
              setDirection(i > index ? 1 : -1);
              setIndex(i);
            }}
            aria-label={`Go to page ${i + 1}`}
            className={`h-2.5 w-2.5 rounded-full ring-1 ring-white/20 transition ${
              i === index ? "bg-white/80" : "bg-white/20 hover:bg-white/40"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
