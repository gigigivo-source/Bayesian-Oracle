"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { cn } from "./ui";
import { NAV_PILL, NAV_PILL_OFF, NAV_PILL_ON_VIOLET, OUTLINE_CYAN } from "../design";

const NAV = [
  { href: "/performance", label: "Leagues", short: "Leagues" },
  { href: "/performance/value-bets", label: "Value Bets", short: "Value" },
  { href: "/performance/accumulators", label: "Accumulators", short: "Accas" },
] as const;

export function PerformanceShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const navLinks = (mobile = false) =>
    NAV.map((item) => {
      const active = item.href === "/performance" ? pathname === "/performance" : pathname === item.href;
      return (
        <Link
          key={item.href}
          href={item.href}
          onClick={() => setMenuOpen(false)}
          className={cn(
            NAV_PILL,
            mobile ? "w-full px-4 py-2 text-sm" : "px-3 py-2 text-sm lg:px-4 lg:text-base",
            active ? NAV_PILL_ON_VIOLET : NAV_PILL_OFF,
          )}
        >
          <span className="hidden lg:inline">{item.label}</span>
          <span className="lg:hidden">{item.short}</span>
        </Link>
      );
    });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 antialiased">
      <header className="sticky top-0 z-40 border-b border-slate-700 bg-slate-900 shadow-lg">
        <div className="relative mx-auto grid max-w-7xl grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 text-sm md:grid-cols-[1fr_auto_1fr] md:px-6 md:py-3 lg:px-8 lg:py-4 lg:text-base">
          <Link
            href="/"
            className="flex min-w-0 cursor-pointer select-none items-center gap-2 transition-all duration-200 hover:opacity-90 active:scale-95 sm:gap-3"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-amber-400/30 bg-amber-400/20">
              <span className="text-xl" aria-hidden="true">⚽</span>
            </div>
            <div className="min-w-0">
              <h1 className="truncate bg-gradient-to-r from-amber-500 to-orange-500 bg-clip-text font-mono text-base font-extrabold tracking-tight text-transparent lg:text-lg">
                ĞIGI GIVØ
              </h1>
              <p className="hidden truncate font-mono text-xs text-slate-400 sm:block">
                Performance · Transparent Track Record
              </p>
            </div>
          </Link>

          <nav className="hidden items-center justify-center gap-2 rounded-full border border-slate-700 bg-slate-800 p-1.5 shadow-inner shadow-slate-950/40 md:flex" aria-label="Performance pages">
            {navLinks()}
          </nav>

          <div className="flex items-center justify-end gap-2">
            <Link href="/" className={cn(OUTLINE_CYAN, "hidden md:inline-flex")}>
              ← App
            </Link>
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-controls="performance-mobile-nav"
              aria-label={menuOpen ? "Close performance menu" : "Open performance menu"}
              className={cn(NAV_PILL, NAV_PILL_OFF, "px-3 py-2 text-sm md:hidden")}
            >
              <span aria-hidden="true">{menuOpen ? "✕" : "☰"}</span>
              Menu
            </button>
          </div>

          {menuOpen ? (
            <nav
              id="performance-mobile-nav"
              className="absolute left-4 right-4 top-full z-50 mt-2 flex flex-col gap-2 rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl md:hidden"
              aria-label="Mobile performance pages"
            >
              {navLinks(true)}
              <Link href="/" className={cn(OUTLINE_CYAN, "justify-center")}>
                ← Back to app
              </Link>
            </nav>
          ) : null}
        </div>
      </header>

      <div className="border-b border-slate-700 bg-slate-900">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 md:py-7 lg:px-8 lg:py-8">
          <h2 className="text-xl font-bold tracking-tight text-white md:text-2xl lg:text-3xl">{title}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-400 lg:text-base">{subtitle}</p>
        </div>
      </div>

      <main className="mx-auto max-w-7xl space-y-4 px-4 py-4 sm:px-6 sm:py-6 md:space-y-6 lg:space-y-8 lg:px-8 lg:py-8">
        {children}
      </main>

      <footer className="border-t border-slate-700 bg-slate-900 px-4 py-6 text-center sm:px-6 lg:px-8">
        <p className="mx-auto max-w-7xl font-mono text-xs leading-relaxed text-slate-400 sm:text-sm">
          ĞIGI GIVØ · All metrics derived from verified post-match data · No hidden calculations
        </p>
      </footer>
    </div>
  );
}
