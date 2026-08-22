"use client";

import { useEffect, useState } from "react";

function viewportLabel(width: number): "Mobile" | "Tablet" | "Desktop" {
  if (width < 768) return "Mobile";
  if (width < 1024) return "Tablet";
  return "Desktop";
}

/**
 * Small responsive QA aid rendered by the root layout on every route.
 * The requestAnimationFrame guard keeps resize updates smooth while users
 * drag a desktop browser through the supported breakpoints.
 */
export function ViewportIndicator() {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(window.innerWidth));
    };

    update();
    window.addEventListener("resize", update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
    };
  }, []);

  if (width === null) return null;

  return (
    <output
      className="viewport-debug fixed bottom-4 right-4 z-50 rounded-full border border-slate-700 bg-slate-900/90 px-3 py-1 text-xs text-white shadow-lg backdrop-blur-sm"
      aria-label={`Current viewport: ${viewportLabel(width)}, ${width} pixels wide`}
    >
      {viewportLabel(width)} · {width}px
    </output>
  );
}
