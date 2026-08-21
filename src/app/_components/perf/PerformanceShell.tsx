"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "./ui";

const NAV = [
  { href: "/performance", label: "Oracle", short: "Oracle Picks" },
  { href: "/performance/value-bets", label: "Value Bets", short: "Value Bets" },
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
  return (
    <div className="min-h-screen bg-[#05070d] text-slate-100 antialiased">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-white/5 bg-black/60 shadow-lg backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link href="/" className="flex items-center gap-3 transition hover:opacity-90">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-400/30 bg-amber-400/20">
                <span className="text-xl">⚽</span>
              </div>
              <div>
                <h1 className="bg-gradient-to-r from-amber-300 via-yellow-200 to-emerald-300 bg-clip-text font-mono text-base font-extrabold tracking-tight text-transparent">
                  ĞIGI GIVØ
                </h1>
                <p className="font-mono text-[10px] text-slate-400">Performance · Transparent Track Record</p>
              </div>
            </Link>
            <div className="flex items-center gap-2">
              {/* Sub-page nav */}
              <nav className="flex gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-1">
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
                        "rounded-md px-3 py-1.5 text-xs font-medium transition",
                        active
                          ? "bg-amber-400 font-bold text-slate-950"
                          : "text-slate-300 hover:bg-white/5",
                      )}
                    >
                      <span className="hidden sm:inline">{n.label}</span>
                      <span className="sm:hidden">{n.short}</span>
                    </Link>
                  );
                })}
              </nav>
              <Link
                href="/"
                className="rounded-lg border border-white/15 bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-white/10"
              >
                ← App
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Title banner */}
      <div className="border-b border-white/5 bg-gradient-to-b from-black/40 to-transparent">
        <div className="mx-auto max-w-7xl px-4 py-6">
          <h2 className="text-xl font-extrabold tracking-tight text-white sm:text-2xl">{title}</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">{subtitle}</p>
        </div>
      </div>

      <main className="mx-auto max-w-7xl space-y-8 px-4 py-8">{children}</main>

      <footer className="border-t border-white/5 bg-black/40 py-4 text-center">
        <p className="font-mono text-[11px] text-slate-500">
          ĞIGI GIVØ · All metrics derived from verified post-match data · No hidden calculations
        </p>
      </footer>
    </div>
  );
}
