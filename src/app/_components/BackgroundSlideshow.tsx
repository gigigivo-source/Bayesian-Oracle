"use client";

import { useEffect, useState } from "react";

// Dark atmospheric football images — no fake player labels on stock photos
const SLIDES = [
  // AI-generated player-style images
  { url: "/slides/slide1.jpg" },
  { url: "/slides/slide2.jpg" },
  { url: "/slides/slide3.jpg" },
  { url: "/slides/slide4.jpg" },
  { url: "/slides/slide5.jpg" },
  { url: "/slides/slide6.jpg" },
  { url: "/slides/slide7.jpg" },
  { url: "/slides/slide8.jpg" },
  // Dark moody real football photography
  { url: "https://images.pexels.com/photos/36737328/pexels-photo-36737328.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
  { url: "https://images.pexels.com/photos/16826138/pexels-photo-16826138.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
  { url: "https://images.pexels.com/photos/36737326/pexels-photo-36737326.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
  { url: "https://images.pexels.com/photos/12616082/pexels-photo-12616082.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
  { url: "https://images.pexels.com/photos/37313578/pexels-photo-37313578.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
  { url: "https://images.pexels.com/photos/36862523/pexels-photo-36862523.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
  { url: "https://images.pexels.com/photos/28829501/pexels-photo-28829501.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
  { url: "https://images.pexels.com/photos/33210167/pexels-photo-33210167.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
  { url: "https://images.pexels.com/photos/32205615/pexels-photo-32205615.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
  { url: "https://images.pexels.com/photos/16651656/pexels-photo-16651656.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
  { url: "https://images.pexels.com/photos/35898730/pexels-photo-35898730.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
  { url: "https://images.pexels.com/photos/33110114/pexels-photo-33110114.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
  { url: "https://images.pexels.com/photos/15949231/pexels-photo-15949231.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
  { url: "https://images.pexels.com/photos/28827841/pexels-photo-28827841.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
  { url: "https://images.pexels.com/photos/29388532/pexels-photo-29388532.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
  { url: "https://images.pexels.com/photos/32266301/pexels-photo-32266301.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
  { url: "https://images.pexels.com/photos/34691108/pexels-photo-34691108.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1080&w=1920" },
];

const SLIDE_MS = 5000;

export function BackgroundSlideshow() {
  const [current, setCurrent] = useState(0);
  const [previous, setPrevious] = useState<number | null>(null);
  // Slides whose image failed to load (e.g. missing file) are skipped in the rotation.
  const [failed, setFailed] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    // Respect the OS "reduce motion" setting — and don't burn CPU animating a
    // background nobody asked for.
    if (typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const timer = setInterval(() => {
      // A hidden tab still runs timers in some browsers; skip the work entirely.
      if (typeof document !== "undefined" && document.hidden) return;

      setCurrent((prev) => {
        // Advance to the next slide that hasn't failed to load
        let next = (prev + 1) % SLIDES.length;
        for (let hops = 0; hops < SLIDES.length && failed.has(next); hops++) {
          next = (next + 1) % SLIDES.length;
        }
        if (next === prev) return prev;
        setPrevious(prev);
        return next;
      });
    }, SLIDE_MS);
    return () => clearInterval(timer);
  }, [failed]);

  // Only the outgoing, current and next slides are ever in the DOM. The old
  // implementation kept every slide it had visited mounted, so after a few
  // minutes ~25 full-HD images were decoded, layered and Ken Burns-animated
  // simultaneously — which pegged the compositor and made the whole UI janky.
  const nextIndex = (current + 1) % SLIDES.length;
  const window_: number[] = [];
  for (const i of [previous, current, nextIndex]) {
    if (i !== null && i !== undefined && !failed.has(i) && !window_.includes(i)) {
      window_.push(i);
    }
  }

  const markFailed = (i: number) =>
    setFailed((f) => {
      if (f.has(i)) return f;
      const nf = new Set(f);
      nf.add(i);
      return nf;
    });

  return (
    <div className="slideshow-root fixed inset-0 z-0 overflow-hidden" aria-hidden>
      {window_.map((i) => {
        const isCurrent = i === current;
        return (
          <div
            key={i}
            className="absolute inset-0 transition-opacity duration-[2000ms] ease-in-out"
            style={{ opacity: isCurrent ? 1 : 0 }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={SLIDES[i].url}
              alt=""
              // Only the visible slide gets the Ken Burns animation; the
              // preloaded neighbour is decoded but never animated.
              className={`h-full w-full object-cover brightness-[0.35]${isCurrent ? " slideshow-kenburns" : ""}`}
              loading={isCurrent ? "eager" : "lazy"}
              decoding="async"
              fetchPriority={isCurrent ? "high" : "low"}
              onError={() => markFailed(i)}
            />
          </div>
        );
      })}
    </div>
  );
}
