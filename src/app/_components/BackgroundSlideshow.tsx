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

export function BackgroundSlideshow() {
  const [current, setCurrent] = useState(0);
  const [loaded, setLoaded] = useState<Set<number>>(new Set([0]));

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrent((prev) => {
        const next = (prev + 1) % SLIDES.length;
        setLoaded((s) => {
          const ns = new Set(s);
          ns.add(next);
          ns.add((next + 1) % SLIDES.length);
          return ns;
        });
        return next;
      });
    }, 5000);
    setLoaded(new Set([0, 1]));
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="fixed inset-0 z-0 overflow-hidden" aria-hidden>
      {SLIDES.map((s, i) => (
        <div
          key={i}
          className="absolute inset-0 transition-opacity duration-[2000ms] ease-in-out"
          style={{ opacity: current === i ? 1 : 0 }}
        >
          {loaded.has(i) && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={s.url}
              alt="Football"
              className="h-full w-full object-cover brightness-[0.35]"
              loading={i < 2 ? "eager" : "lazy"}
            />
          )}
        </div>
      ))}

      {/* Ken Burns zoom */}
      <style>{`
        @keyframes kenburns {
          0% { transform: scale(1) translate(0, 0); }
          50% { transform: scale(1.08) translate(-1%, -1%); }
          100% { transform: scale(1) translate(0, 0); }
        }
        [aria-hidden] > div > img {
          animation: kenburns 20s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}
