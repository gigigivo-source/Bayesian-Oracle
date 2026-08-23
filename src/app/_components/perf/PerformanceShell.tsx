"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "./ui";
import { NAV_PILL, NAV_PILL_OFF, NAV_PILL_ON_VIOLET, OUTLINE_CYAN } from "../design";

const NAV = [
  { href: "/performance", label: "Leagues", short: "Leagues" },
  { href: "/performance/value-bets", label: "Value Bets", short: "Value Bets" },
  { href: "/performance/accumulators", label: "Accumulators", short: "Accas" },
  { href: "/performance/modes", label: "Ranking Modes", short: "Modes" },
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
  return (
    <div className="min-h-screen bg-[#0F1117] text-slate-100 antialiased">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-slate-700 bg-slate-900 shadow-lg ">
        <div className="mx-auto max-w-7xl px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link href="/" className="flex cursor-pointer select-none items-center gap-3 transition-all duration-200 hover:scale-[1.02] hover:opacity-90 active:scale-95">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-400/30 bg-amber-400/20">
                <span className="text-xl">⚽</span>
              </div>
              <div>
                <h1 className="bg-gradient-to-r from-[#F59E0B] to-[#FF8C00] bg-clip-text font-mono text-base font-extrabold tracking-tight text-transparent">
                  ĞIGI GIVØ
                </h1>
                <p className="font-mono text-[10px] text-slate-400">Performance · Transparent Track Record</p>
              </div>
            </Link>
            <div className="flex items-center gap-2">
              {/* Sub-page nav — TYPE 1 solid slate pills (gold active state) */}
              <nav className="flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800 p-1.5 shadow-inner shadow-slate-950/40 ">
                {NAV.map((n) => {
                  const active =
                    n.href === "/performance"
                      ? pathname === "/performance"
                      : pathname === n.href;
                  return (
                    <Link
                      key={n.href}
                      href={n.href}
                      className={cn(
                        NAV_PILL,
                        "px-3 py-1.5 text-xs font-medium",
                        active ? NAV_PILL_ON_VIOLET : NAV_PILL_OFF,
                      )}
                    >
                      <span className="hidden sm:inline">{n.label}</span>
                      <span className="sm:hidden">{n.short}</span>
                    </Link>
                  );
                })}
              </nav>
              <Link href="/" className={cn(OUTLINE_CYAN, "px-3 py-1.5 text-xs")}>
                ← App
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Title banner */}
      <div className="border-b border-slate-700 bg-slate-900">
        <div className="mx-auto max-w-7xl px-4 py-6">
          <h2 className="text-xl font-extrabold tracking-tight text-white sm:text-2xl">{title}</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">{subtitle}</p>
        </div>
      </div>

      <main className="mx-auto max-w-7xl space-y-8 px-4 py-8">{children}</main>

      <footer className="border-t border-slate-700 bg-slate-800 py-4 text-center">
        <p className="font-mono text-[11px] text-slate-500">
          ĞIGI GIVØ · All metrics derived from verified post-match data · No hidden calculations
        </p>
      </footer>
    </div>
  );
}
