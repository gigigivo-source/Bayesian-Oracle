"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FixtureLite } from "@/lib/espn";
import type { LeagueDef } from "@/lib/leagues";

import { FixtureCard } from "./_components/ui";
import { MatchDetail } from "./_components/MatchDetail";
import { BackgroundSlideshow } from "./_components/BackgroundSlideshow";
import { ErrorBoundary } from "./_components/ErrorBoundary";

type Tab = "top" | "live" | "accumulators" | "performance" | "leagues" | "standings" | "oracle" | "chat" | "bankroll" | "slipbuilder" | "dailypicks" | "oddscalc" | "verified" | "results" | "backtest" | "valuebets";

interface FeaturedBlock {
  slug: string;
  label: string;
  fixtures: FixtureLite[];
  upcoming: FixtureLite[];
  results: FixtureLite[];
}

interface TopData {
  featured: FeaturedBlock[];
  extra: FeaturedBlock[];
  live: FixtureLite[];
  liveCount: number;
}

const TOP_LEAGUE_PILLS = [
  { slug: "fifa.world", name: "World Cup", logo: "https://a.espncdn.com/i/leaguelogos/soccer/500/4.png" },
  { slug: "eng.1", name: "Premier League", logo: "https://a.espncdn.com/i/leaguelogos/soccer/500/23.png" },
  { slug: "esp.1", name: "LaLiga", logo: "https://a.espncdn.com/i/leaguelogos/soccer/500/15.png" },
  { slug: "ita.1", name: "Serie A", logo: "https://a.espncdn.com/i/leaguelogos/soccer/500/12.png" },
  { slug: "fra.1", name: "Ligue 1", logo: "https://a.espncdn.com/i/leaguelogos/soccer/500/9.png" },
  { slug: "ger.1", name: "Bundesliga", logo: "https://a.espncdn.com/i/leaguelogos/soccer/500/10.png" },
  { slug: "uefa.champions", name: "UCL", logo: "https://a.espncdn.com/i/leaguelogos/soccer/500/2.png" },
  { slug: "uefa.europa", name: "Europa", logo: "https://a.espncdn.com/i/leaguelogos/soccer/500/2310.png" },
  { slug: "conmebol.libertadores", name: "Libertadores", logo: "https://a.espncdn.com/i/leaguelogos/soccer/500/58.png" },
  { slug: "usa.1", name: "MLS", logo: "https://a.espncdn.com/i/leaguelogos/soccer/500/19.png" },
  { slug: "bra.1", name: "Série A", logo: "https://a.espncdn.com/i/leaguelogos/soccer/500/85.png" },
  { slug: "mex.1", name: "Liga MX", logo: "https://a.espncdn.com/i/leaguelogos/soccer/500/22.png" },
  { slug: "arg.1", name: "Liga Pro", logo: "https://a.espncdn.com/i/leaguelogos/soccer/500/1.png" },
];

const ALL_TABS: readonly Tab[] = ["top", "live", "accumulators", "performance", "leagues", "standings", "oracle", "chat", "bankroll", "slipbuilder", "dailypicks", "oddscalc", "verified", "results", "backtest", "valuebets"];

export default function Home() {
  const [tab, setTab] = useState<Tab>("top");
  const [selected, setSelected] = useState<FixtureLite | null>(null);
  const [selectedLeagueSlug, setSelectedLeagueSlug] = useState<string | null>(null);
  const [showTodayOnly, setShowTodayOnly] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [pinInput, setPinInput] = useState("");
  const [pinName, setPinName] = useState("");
  const [pinError, setPinError] = useState("");

  useEffect(() => {
    fetch("/api/auth").then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).then((d: { hasPin: boolean }) => {
      setHasPin(d.hasPin);
      if (!d.hasPin) setAuthed(true); // No PIN set = open access
    }).catch(() => { setHasPin(false); setAuthed(true); });
  }, []);

  // Support in-app navigation events (e.g. Standings "View Fixtures →" button)
  useEffect(() => {
    const onTabEvent = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      // "fixtures" is a legacy alias for the league fixture browser
      const target: Tab | null = detail === "fixtures" ? "leagues" : (ALL_TABS as readonly string[]).includes(detail) ? (detail as Tab) : null;
      if (target) setTab(target);
    };
    window.addEventListener("gigi-tab", onTabEvent);
    return () => window.removeEventListener("gigi-tab", onTabEvent);
  }, []);

  async function handlePin() {
    try {
      if (!hasPin) {
        // Setup new PIN
        if (pinInput.length < 4) { setPinError("PIN must be at least 4 digits"); return; }
        await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "setup", pin: pinInput, name: pinName || "User" }) });
        setAuthed(true);
      } else {
        // Verify PIN
        const r = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", pin: pinInput }) });
        const d = await r.json() as { valid: boolean };
        if (d.valid) { setAuthed(true); setPinError(""); }
        else setPinError("Incorrect PIN");
      }
    } catch {
      setPinError("Something went wrong. Please try again.");
    }
  }

  if (hasPin === null) return <div className="min-h-screen bg-[#05070d] flex items-center justify-center"><div className="text-amber-300 font-mono animate-pulse">Loading...</div></div>;

  if (!authed) return (
    <div className="min-h-screen bg-[#05070d] flex items-center justify-center">
      <div className="bg-black/50 rounded-xl p-8 w-full max-w-sm text-center">
        <div className="w-[60px] h-[60px] rounded-lg mx-auto mb-4 bg-amber-400/20 border border-amber-400/30 flex items-center justify-center">
          <span className="text-2xl">⚽</span>
        </div>
        <h1 className="text-xl font-bold text-amber-300 font-mono mb-1">GIGI GIVO</h1>
        <p className="text-xs text-slate-400 mb-6">{hasPin ? "Enter your PIN to continue" : "Set a PIN to secure your app"}</p>
        {!hasPin && (
          <input value={pinName} onChange={e => setPinName(e.target.value)} placeholder="Your name"
            className="w-full rounded-lg border border-white/15 bg-black/40 px-4 py-2.5 text-sm text-white outline-none focus:border-amber-400 mb-3" />
        )}
        <input value={pinInput} onChange={e => setPinInput(e.target.value)} placeholder={hasPin ? "Enter PIN" : "Create PIN (4+ digits)"}
          type="password" onKeyDown={e => { if (e.key === "Enter") handlePin(); }}
          className="w-full rounded-lg border border-white/15 bg-black/40 px-4 py-3 text-center text-2xl tracking-[0.5em] text-white outline-none focus:border-amber-400 font-mono" />
        {pinError && <p className="text-rose-400 text-xs mt-2">{pinError}</p>}
        <button onClick={handlePin} className="w-full mt-4 rounded-lg bg-amber-400 py-3 text-sm font-bold text-slate-950 hover:bg-amber-300">
          {hasPin ? "Unlock" : "Set PIN & Start"}
        </button>
      </div>
    </div>
  );

  return (
    <div className={`min-h-screen text-slate-100 ${tab !== "top" ? "bg-[#05070d]" : ""}`}>
      {tab === "top" && <BackgroundSlideshow />}
      <div className="relative z-10">
        <Header tab={tab} setTab={setTab} />

        {/* LEAGUE CHIPS — only on Top Matches tab */}
        {tab === "top" && (
          <div className="sticky top-[99px] z-30 bg-black/55 py-2 px-4 overflow-x-auto scrollbar-none">
            <div className="mx-auto flex max-w-7xl items-center gap-2">
              <button
                onClick={() => { setSelectedLeagueSlug(null); setShowTodayOnly(false); }}
                className={`rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap transition border ${
                  selectedLeagueSlug === null && !showTodayOnly
                    ? "bg-amber-400 text-slate-950 border-amber-400"
                    : "border-white/15 bg-white/5 text-slate-300 hover:bg-white/10"
                }`}
              >
                All
              </button>
              {/* TODAY chip */}
              <button
                onClick={() => { setShowTodayOnly(true); setSelectedLeagueSlug(null); }}
                className={`rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap transition border flex items-center gap-1.5 ${
                  showTodayOnly
                    ? "bg-emerald-400 text-slate-950 border-emerald-400"
                    : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                }`}
              >
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                Today
              </button>
              {/* separator */}
              <span className="h-4 w-px bg-white/15 mx-1 shrink-0" />
              {TOP_LEAGUE_PILLS.map((lg) => (
                <button
                  key={lg.slug}
                  onClick={() => {
                    setSelectedLeagueSlug(lg.slug);
                    const el = document.getElementById(`league-sec-${lg.slug}`);
                    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  className={`rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap transition flex items-center gap-1.5 border ${
                    selectedLeagueSlug === lg.slug
                      ? "bg-amber-400 text-slate-950 border-amber-400"
                      : "border-white/15 bg-white/5 text-slate-300 hover:bg-white/10"
                  }`}
                >
                  <Image src={lg.logo} alt={lg.name} width={16} height={16} className="object-contain" unoptimized />
                  <span>{lg.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <main className="mx-auto max-w-7xl px-4 py-8">
          <ErrorBoundary key={tab}>
            {tab === "top" && (
              <TopFeed
                onSelect={setSelected}
                filterSlug={selectedLeagueSlug}
                onClearFilter={() => { setSelectedLeagueSlug(null); setShowTodayOnly(false); }}
                showTodayOnly={showTodayOnly}
                onClearToday={() => setShowTodayOnly(false)}
              />
            )}
            {tab === "live" && <LivePage onSelect={setSelected} />}
            {tab === "accumulators" && <AccumulatorPage />}
            {tab === "performance" && <PerformanceDashboard />}
            {tab === "leagues" && <LeagueBrowser onSelect={setSelected} />}
            {tab === "standings" && <StandingsView />}
            {tab === "oracle" && <ManualOracle />}
            {tab === "chat" && <ChatAssistant />}
            {tab === "bankroll" && <BankrollTracker />}
            {tab === "dailypicks" && <DailyPicksPage />}
            {tab === "oddscalc" && <OddsCalculator />}
            {tab === "verified" && <VerifiedPage />}
            {tab === "results" && <ResultsPage onSelect={setSelected} />}
            {tab === "backtest" && <BacktestDashboard />}
            {tab === "valuebets" && <ValueBetsPage />}
          </ErrorBoundary>
        </main>

        {selected ? (
          <ErrorBoundary>
            <MatchDetail fixture={selected} onClose={() => setSelected(null)} />
          </ErrorBoundary>
        ) : null}

        <footer className="bg-black/50 py-4 text-center text-xs text-slate-300 font-mono">
          ĞIGI GIVØ Proprietary Sportsbook Engine · Real Data Mesh · Zero Simulation
        </footer>
      </div>
    </div>
  );
}

// --------------- LIVE PAGE ---------------
function LivePage({ onSelect }: { onSelect: (fx: FixtureLite) => void }) {
  const [live, setLive] = useState<FixtureLite[]>([]);
  const [recent, setRecent] = useState<FixtureLite[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    function load() {
      fetch("/api/top")
        .then((r) => r.json())
        .then((d: TopData) => {
          setLive(d.live ?? []);
          const finished = (d.featured ?? []).flatMap((b: FeaturedBlock) => b.fixtures.filter((f: FixtureLite) => f.state === "post")).slice(0, 8);
          const upcoming = (d.featured ?? []).flatMap((b: FeaturedBlock) => b.upcoming ?? []).slice(0, 8);
          setRecent([...finished, ...upcoming]);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  if (loading) return <LoadingGrid label="Checking live matches worldwide…" />;

  return (
    <div className="space-y-8">
      {live.length > 0 ? (
        <div>
          <div className="mb-3 inline-flex items-center gap-2 bg-black/60 rounded-lg px-3 py-1.5">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-rose-500" />
            </span>
            <h2 className="text-sm font-bold text-white">LIVE NOW — {live.length} Match{live.length > 1 ? "es" : ""} In-Play</h2>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {live.map((fx) => (
              <FixtureCard key={`live-${fx.id}`} fx={fx} onSelect={onSelect} live />
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-black/50 rounded-lg p-10 text-center">
          <div className="text-lg font-bold text-slate-300 mb-2">No matches are live right now</div>
          <p className="text-sm text-slate-400 font-mono">Live scores auto-refresh every 15 seconds. Check back during match hours.</p>
        </div>
      )}

      {recent.length > 0 && (
        <div>
          <div className="mb-3 inline-block bg-black/60 rounded-lg px-3 py-1.5">
            <h2 className="text-sm font-bold text-white">Today&apos;s Schedule & Recent Results</h2>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {recent.map((fx) => (
              <FixtureCard key={`recent-${fx.leagueSlug}-${fx.id}`} fx={fx} onSelect={onSelect} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Header({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);

  const mainTabs: Array<{ id: Tab; label: string }> = [
    { id: "top", label: "Top Matches" },
    { id: "live", label: "Live" },
    { id: "leagues", label: "All Leagues" },
    { id: "standings", label: "Standings" },
  ];

  const menuTabs: Array<{ id: Tab; label: string; desc: string }> = [
    { id: "accumulators", label: "Accumulators",  desc: "High-hit, value bets & bankroll" },
    { id: "performance",  label: "Performance",   desc: "Track record & accuracy stats" },
    { id: "backtest",     label: "⚡ Backtest",    desc: "Live engine accuracy on real finished matches" },
    { id: "valuebets",    label: "💰 Value Bets", desc: "Track value bets & post-match P&L verification" },
    { id: "dailypicks",   label: "Daily Picks",   desc: "Today's best picks across all leagues" },
    { id: "results",      label: "Results",       desc: "Recent finished matches across leagues" },
    { id: "verified",     label: "Verification",  desc: "Post-match auto-verified oracle picks" },
    { id: "oracle",       label: "Oracle Search", desc: "Search & analyse any fixture" },
    { id: "oddscalc",     label: "Odds Calculator", desc: "Convert odds, dutching, hedging" },
    { id: "chat",         label: "Ask Anything",  desc: "Web search chat assistant" },
  ];

  const activeInMenu = menuTabs.some((t) => t.id === tab);

  return (
    <header className="sticky top-0 z-40 bg-black/60 shadow-lg backdrop-blur-sm">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-2">
        <div className="flex items-center gap-3">
          <div className="h-[38px] w-[38px] rounded-lg bg-amber-400/20 border border-amber-400/30 flex items-center justify-center">
            <span className="text-xl">⚽</span>
          </div>
          <div>
            <h1 className="bg-gradient-to-r from-amber-300 via-yellow-200 to-emerald-300 bg-clip-text font-mono text-lg font-extrabold tracking-tight text-transparent">
              ĞIGI GIVØ
            </h1>
            <p className="text-[10px] text-slate-400 font-mono">Bayesian Oracle · Deep Statistical Engine</p>
          </div>
        </div>
        <nav className="flex gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-1 items-center">
          {mainTabs.map((t) => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id); setMenuOpen(false); }}
              className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition ${
                tab === t.id
                  ? "bg-amber-400 text-slate-950 font-bold"
                  : "text-slate-300 hover:bg-white/5"
              }`}
            >
              {t.label}
            </button>
          ))}

          {/* Menu dropdown */}
          <div className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition flex items-center gap-1.5 ${
                activeInMenu
                  ? "bg-amber-400 text-slate-950 font-bold"
                  : "text-slate-300 hover:bg-white/5"
              }`}
            >
              Menu
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points={menuOpen ? "2,7 5,3 8,7" : "2,3 5,7 8,3"} />
              </svg>
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 w-56 rounded-lg bg-black/90 border border-white/15 shadow-xl z-50 overflow-hidden">
                {menuTabs.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => { setTab(t.id); setMenuOpen(false); }}
                    className={`w-full text-left px-4 py-3 transition border-b border-white/5 last:border-0 ${
                      tab === t.id
                        ? "bg-amber-400/10 text-amber-300"
                        : "text-slate-200 hover:bg-white/5"
                    }`}
                  >
                    <div className="text-sm font-medium">{t.label}</div>
                    <div className="text-[10px] text-slate-400">{t.desc}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
}

function LoadingGrid({ label }: { label: string }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg bg-black/50 px-4 py-3">
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-500" />
        </span>
        <span className="animate-pulse font-mono text-sm text-amber-300">{label}</span>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="overflow-hidden rounded-lg border border-white/10 bg-black/50 p-3">
            <div className="mb-3 flex items-center justify-between">
              <div className="h-2.5 w-20 animate-pulse bg-white/10 rounded" />
              <div className="h-2.5 w-10 animate-pulse bg-white/10 rounded" />
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-5 w-5 animate-pulse bg-white/10 rounded-full" />
                <div className="h-3 flex-1 animate-pulse bg-white/10 rounded" />
                <div className="h-3 w-5 animate-pulse bg-white/10 rounded" />
              </div>
              <div className="flex items-center gap-2">
                <div className="h-5 w-5 animate-pulse bg-white/10 rounded-full" />
                <div className="h-3 flex-1 animate-pulse bg-white/10 rounded" />
                <div className="h-3 w-5 animate-pulse bg-white/10 rounded" />
              </div>
            </div>
            <div className="mt-3 h-2 w-24 animate-pulse bg-white/10 rounded border-t border-white/5 pt-2" />
          </div>
        ))}
      </div>
    </div>
  );
}

// --------------- TOP FEED ---------------
function TopFeed({
  onSelect,
  filterSlug,
  onClearFilter,
  showTodayOnly = false,
  onClearToday,
}: {
  onSelect:      (fx: FixtureLite) => void;
  filterSlug:    string | null;
  onClearFilter: () => void;
  showTodayOnly?: boolean;
  onClearToday?:  () => void;
}) {
  const [data, setData] = useState<TopData | null>(null);
  // Fixtures loaded from /api/fixtures when a chip points to a league with no today matches.
  // Keyed by league slug so stale data is never shown for a different chip.
  const [chipData, setChipData] = useState<{ slug: string; upcoming: FixtureLite[]; results: FixtureLite[]; label: string } | null>(null);

  useEffect(() => {
    fetch("/api/top")
      .then((r) => r.json())
      .then((d: TopData) => setData(d))
      .catch(() => setData({ featured: [], extra: [], live: [], liveCount: 0 }));
  }, []);

  // When a chip is selected, check if that league has data in top feed.
  // If not (off-season / no today's match), load full fixture schedule instead.
  const needsChipFixtures = useMemo(() => {
    if (!filterSlug || !data) return false;
    const block = data.featured.find((b) => b.slug === filterSlug);
    const hasMatches = block && ((block.upcoming?.length ?? 0) > 0 || (block.results?.length ?? 0) > 0);
    return !hasMatches;
  }, [filterSlug, data]);

  useEffect(() => {
    if (!filterSlug || !needsChipFixtures) return;

    // No today matches — load full fixture schedule (60-day window)
    const pill = TOP_LEAGUE_PILLS.find((p) => p.slug === filterSlug);
    let cancelled = false;
    fetch(`/api/fixtures?league=${filterSlug}`)
      .then((r) => r.json())
      .then((d: { upcoming: FixtureLite[]; results: FixtureLite[]; league?: { name: string } }) => {
        if (cancelled) return;
        setChipData({
          slug:     filterSlug,
          upcoming: d.upcoming ?? [],
          results:  d.results  ?? [],
          label:    d.league?.name ?? pill?.name ?? filterSlug,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setChipData({ slug: filterSlug, upcoming: [], results: [], label: pill?.name ?? filterSlug });
      });
    return () => { cancelled = true; };
  }, [filterSlug, needsChipFixtures]);

  if (!data) return <LoadingGrid label="Connecting to Football Data Mesh…" />;

  const chipFixtures = needsChipFixtures && chipData && chipData.slug === filterSlug ? chipData : null;
  const chipLoading  = needsChipFixtures && !chipFixtures;

  // Today's date string for filtering
  const todayStr = new Date().toISOString().slice(0, 10);

  // Filter fixtures to today only
  const filterToday = (fx: FixtureLite) =>
    fx.date.slice(0, 10) === todayStr;

  const filterBlocks = (blocks: FeaturedBlock[]) =>
    blocks
      .map((b) => ({
        ...b,
        upcoming: (b.upcoming ?? []).filter(showTodayOnly ? (f) => filterToday(f) : () => true),
        results:  (b.results  ?? []).filter(showTodayOnly ? (f) => filterToday(f) : () => true),
      }))
      .filter((b) => b.upcoming.length > 0 || b.results.length > 0);

  const filteredBlocks = filterBlocks(
    filterSlug ? data.featured.filter((b) => b.slug === filterSlug) : data.featured
  );

  // Count today's total matches across all leagues
  const todayMatchCount = showTodayOnly
    ? [...data.featured, ...data.extra].flatMap((b) => [
        ...(b.upcoming ?? []).filter(filterToday),
        ...(b.results  ?? []).filter(filterToday),
      ]).length
    : 0;

  return (
    <div className="space-y-10">
      {/* Active filter banners */}
      {showTodayOnly && (
        <div className="flex items-center justify-between rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-4 py-2 text-sm text-emerald-200">
          <span className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <strong>Today — {todayStr}</strong>
            <span className="text-emerald-300/70 text-xs">({todayMatchCount} matches)</span>
          </span>
          <button onClick={onClearToday} className="text-xs text-emerald-300 hover:text-white underline font-mono">
            Show All ✕
          </button>
        </div>
      )}
      {filterSlug && !showTodayOnly ? (
        <div className="flex items-center justify-between rounded-lg bg-black/50 px-4 py-2 text-sm text-amber-200">
          <span>Filtering: <strong>{TOP_LEAGUE_PILLS.find((p) => p.slug === filterSlug)?.name ?? filterSlug}</strong></span>
          <button onClick={onClearFilter} className="text-xs text-slate-300 hover:text-white underline font-mono">
            Show All ✕
          </button>
        </div>
      ) : null}

      {/* League chip selected but no today's matches → show full fixture schedule */}
      {filterSlug && !showTodayOnly && chipLoading && (
        <LoadingGrid label="Loading fixture schedule…" />
      )}
      {filterSlug && !showTodayOnly && !chipLoading && chipFixtures && (
        <div className="space-y-6">
          {chipFixtures.upcoming.length === 0 && chipFixtures.results.length === 0 ? (
            <div className="bg-black/50 rounded-lg p-8 text-center">
              <div className="text-2xl mb-3">📅</div>
              <div className="text-sm font-bold text-slate-300 mb-2">{chipFixtures.label}</div>
              <p className="text-xs text-slate-400 font-mono">No fixtures found. This league may be in pre-season or the schedule hasn&apos;t been released yet.</p>
            </div>
          ) : (
            <>
              {chipFixtures.upcoming.length > 0 && (
                <div className="space-y-3">
                  <div className="inline-block bg-black/60 rounded-lg px-3 py-1.5">
                    <h2 className="text-sm font-bold text-white">{chipFixtures.label} — Upcoming ({chipFixtures.upcoming.length})</h2>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {chipFixtures.upcoming.map((fx) => (
                      <FixtureCard key={fx.id} fx={fx} onSelect={onSelect} />
                    ))}
                  </div>
                </div>
              )}
              {chipFixtures.results.length > 0 && (
                <div className="space-y-3">
                  <div className="inline-block bg-black/60 rounded-lg px-3 py-1.5">
                    <h2 className="text-sm font-bold text-white">Recent Results ({chipFixtures.results.length})</h2>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {chipFixtures.results.map((fx) => (
                      <FixtureCard key={fx.id} fx={fx} onSelect={onSelect} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {!filterSlug && !showTodayOnly && <ValueAlerts />}

      {/* Today mode: also show extra leagues with today's matches */}
      {showTodayOnly && data.extra.length > 0 && (() => {
        const extraToday = filterBlocks(data.extra);
        if (extraToday.length === 0) return null;
        return (
          <div className="space-y-4">
            {extraToday.map((block) => (
              <section id={`league-sec-${block.slug}`} key={`today-extra-${block.slug}`} className="scroll-mt-36 space-y-3">
                <div className="inline-flex items-center gap-2 bg-black/60 rounded-lg px-3 py-1.5">
                  <h2 className="text-sm font-bold text-white">{block.label}</h2>
                  {block.upcoming.length > 0 && (
                    <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-300 font-mono">
                      {block.upcoming.length} upcoming
                    </span>
                  )}
                  {block.results.length > 0 && (
                    <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-slate-300 font-mono">
                      {block.results.length} results
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {[...block.upcoming, ...block.results].map((fx) => (
                    <FixtureCard key={`today-extra-fx-${fx.id}`} fx={fx} onSelect={onSelect} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        );
      })()}

      {filteredBlocks.length === 0 && showTodayOnly && (
        <div className="bg-black/50 rounded-lg p-10 text-center">
          <div className="text-lg font-bold text-slate-300 mb-2">No matches found for today</div>
          <p className="text-sm text-slate-400 font-mono">Check back later or view all upcoming matches.</p>
        </div>
      )}

      {/* Only show filtered blocks if chip has today's data (not independently loaded) */}
      {(!filterSlug || !chipFixtures) && filteredBlocks.map((block) => {
        const up = block.upcoming ?? block.fixtures.filter((f) => f.state !== "post");
        const res = block.results ?? block.fixtures.filter((f) => f.state === "post");
        if (up.length === 0 && res.length === 0) return null;
        const pill = TOP_LEAGUE_PILLS.find((p) => p.slug === block.slug);
        return (
          <section id={`league-sec-${block.slug}`} key={block.slug} className="scroll-mt-36 space-y-4">
            <div className="inline-flex items-center gap-2 bg-black/60 rounded-lg px-3 py-1.5">
              {pill && (
                <Image src={pill.logo} alt={block.label} width={20} height={20} className="object-contain" unoptimized />
              )}
              <h2 className="text-sm font-bold text-white">{block.label}</h2>
              {up.length > 0 && (
                <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-300 font-mono font-medium">
                  {up.length} upcoming
                </span>
              )}
              {res.length > 0 && (
                <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-slate-300 font-mono font-medium">
                  {res.length} results
                </span>
              )}
            </div>

            {up.length > 0 && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {up.map((fx) => (
                  <FixtureCard key={`${block.slug}-${fx.id}`} fx={fx} onSelect={onSelect} />
                ))}
              </div>
            )}

            {res.length > 0 && (
              <div>
                <div className="mb-2 inline-block bg-black/40 rounded px-2 py-1 text-[11px] font-mono text-slate-400">
                  Recent Results
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {res.map((fx) => (
                    <FixtureCard key={`res-${block.slug}-${fx.id}`} fx={fx} onSelect={onSelect} />
                  ))}
                </div>
              </div>
            )}
          </section>
        );
      })}

      {!filterSlug && !showTodayOnly && data.extra.length > 0 && (
        <section className="pt-4 border-t border-white/10">
          <div className="mb-3 inline-block bg-black/60 rounded-lg px-3 py-1.5">
            <h2 className="text-sm font-bold text-white">More Leagues</h2>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {data.extra.flatMap((b) => b.fixtures).slice(0, 12).map((fx) => (
              <FixtureCard key={`extra-${fx.leagueSlug}-${fx.id}`} fx={fx} onSelect={onSelect} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// --------------- ALL LEAGUES ---------------
function LeagueBrowser({ onSelect }: { onSelect: (fx: FixtureLite) => void }) {
  const [byRegion, setByRegion] = useState<Record<string, LeagueDef[]> | null>(null);
  const [activeLeague, setActiveLeague] = useState<LeagueDef | null>(null);
  const [upcoming, setUpcoming] = useState<FixtureLite[]>([]);
  const [results, setResults] = useState<FixtureLite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadingFx, setLoadingFx] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch("/api/leagues")
      .then((r) => r.json())
      .then((d: { byRegion: Record<string, LeagueDef[]> }) => setByRegion(d.byRegion ?? {}))
      .catch(() => setByRegion({}));
  }, []);

  const loadLeague = useCallback((lg: LeagueDef) => {
    setActiveLeague(lg);
    setUpcoming([]);
    setResults([]);
    setLoaded(false);
    setLoadingFx(true);
    setTimeout(() => {
      const el = document.getElementById("league-fixtures");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
    fetch(`/api/fixtures?league=${lg.slug}`)
      .then((r) => r.json())
      .then((d: { upcoming: FixtureLite[]; results: FixtureLite[] }) => {
        setUpcoming(d.upcoming ?? []);
        setResults(d.results ?? []);
        setLoaded(true);
      })
      .catch(() => { setUpcoming([]); setResults([]); setLoaded(true); })
      .finally(() => setLoadingFx(false));
  }, []);

  const filtered = useMemo(() => {
    if (!byRegion) return null;
    if (!search.trim()) return byRegion;
    const q = search.toLowerCase();
    const out: Record<string, LeagueDef[]> = {};
    for (const [region, lgs] of Object.entries(byRegion)) {
      const m = lgs.filter((l) => l.name.toLowerCase().includes(q) || region.toLowerCase().includes(q));
      if (m.length) out[region] = m;
    }
    return out;
  }, [byRegion, search]);

  if (!filtered) return <LoadingGrid label="Loading leagues…" />;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      <aside className="space-y-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search leagues…"
          className="w-full rounded-md border border-white/15 bg-black/50 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-400"
        />
        <div className="max-h-[75vh] space-y-3 overflow-y-auto pr-1">
          {Object.entries(filtered).map(([region, lgs]) => (
            <div key={region}>
              <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-amber-300 font-mono">{region}</div>
              <div className="space-y-0.5">
                {lgs.map((lg) => (
                  <button
                    key={lg.slug}
                    onClick={() => loadLeague(lg)}
                    className={`w-full rounded-md px-3 py-1.5 text-left text-sm transition ${
                      activeLeague?.slug === lg.slug
                        ? "bg-amber-400/20 text-amber-200 font-bold"
                        : "text-slate-300 hover:bg-white/5"
                    }`}
                  >
                    {lg.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </aside>
      <div id="league-fixtures" className="scroll-mt-24">
        {!activeLeague ? (
          <div className="bg-black/50 rounded-lg p-10 text-center text-slate-400 font-mono">
            Select a league to load fixtures & results.
          </div>
        ) : loadingFx || !loaded ? (
          <LoadingGrid label={`Loading ${activeLeague.name}…`} />
        ) : upcoming.length === 0 && results.length === 0 ? (
          <div className="bg-black/50 rounded-lg p-8 text-center">
            <div className="text-2xl mb-3">📅</div>
            <div className="text-sm font-bold text-slate-300 mb-2">{activeLeague.name}</div>
            <p className="text-xs text-slate-400 font-mono max-w-xs mx-auto">
              No matches found in the current window.<br />
              This league may be in pre-season, off-season, or between matchdays.<br />
              <span className="text-slate-500">Fixtures are checked 14 days ahead.</span>
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {upcoming.length > 0 && (
              <div>
                <div className="mb-3 inline-block bg-black/60 rounded-lg px-3 py-1.5">
                  <h2 className="text-sm font-bold text-white">Upcoming — {activeLeague.name} ({upcoming.length})</h2>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {upcoming.map((fx) => (
                    <FixtureCard key={fx.id} fx={fx} onSelect={onSelect} />
                  ))}
                </div>
              </div>
            )}

            {results.length > 0 && (
              <div>
                <div className="mb-3 inline-block bg-black/60 rounded-lg px-3 py-1.5">
                  <h2 className="text-sm font-bold text-white">Recent Results — {activeLeague.name} ({results.length})</h2>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {results.map((fx) => (
                    <FixtureCard key={`res-${fx.id}`} fx={fx} onSelect={onSelect} />
                  ))}
                </div>
                <p className="mt-3 text-center text-xs text-slate-500 font-mono">
                  Tap any finished match → Oracle + Post-Match Verification
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// --------------- STANDINGS ---------------
interface StandingsEntry {
  rank: number;
  team: string;
  teamLogo: string | null;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  form: string;
}

// Hoisted out of StandingsView so it isn't re-created on every render
function StandingsTable({ entries, activeName }: { entries: StandingsEntry[]; activeName: string }) {
  return (
    <div className="overflow-x-auto rounded-lg bg-black/50">
      <div className="px-3 py-2 bg-black/40 border-b border-white/5 flex items-center gap-2">
        <span className="text-xs font-bold text-amber-300 font-mono">{activeName}</span>
        <span className="text-[10px] text-slate-500 font-mono">— {entries.length} teams</span>
      </div>
      <table className="w-full text-left text-sm font-mono">
        <thead className="bg-black/30 text-[11px] uppercase tracking-wider text-slate-400">
          <tr>
            <th className="px-3 py-2 w-8">#</th>
            <th className="px-3 py-2">Team</th>
            <th className="px-3 py-2 text-center">P</th>
            <th className="px-3 py-2 text-center">W</th>
            <th className="px-3 py-2 text-center">D</th>
            <th className="px-3 py-2 text-center">L</th>
            <th className="px-3 py-2 text-center hidden sm:table-cell">GF</th>
            <th className="px-3 py-2 text-center hidden sm:table-cell">GA</th>
            <th className="px-3 py-2 text-center">GD</th>
            <th className="px-3 py-2 text-center font-bold">Pts</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {entries.map((e, i) => (
            <tr
              key={i}
              className={[
                i < 4  ? "border-l-2 border-l-emerald-500 bg-emerald-500/[0.03]" : "",
                i >= entries.length - 3 ? "border-l-2 border-l-rose-500 bg-rose-500/[0.03]" : "",
                i >= 4 && i < entries.length - 3 ? "hover:bg-white/[0.02]" : "",
              ].join(" ")}
            >
              <td className="px-3 py-1.5 text-slate-400 text-xs">{e.rank}</td>
              <td className="px-3 py-1.5">
                <div className="flex items-center gap-2">
                  {e.teamLogo && (
                    <Image src={e.teamLogo} alt={e.team} width={18} height={18} className="object-contain shrink-0" unoptimized />
                  )}
                  <span className="text-slate-100 font-medium truncate max-w-[120px] sm:max-w-none">{e.team}</span>
                </div>
              </td>
              <td className="px-3 py-1.5 text-center text-slate-300">{e.played}</td>
              <td className="px-3 py-1.5 text-center text-emerald-300">{e.won}</td>
              <td className="px-3 py-1.5 text-center text-slate-400">{e.drawn}</td>
              <td className="px-3 py-1.5 text-center text-rose-400">{e.lost}</td>
              <td className="px-3 py-1.5 text-center text-slate-300 hidden sm:table-cell">{e.goalsFor}</td>
              <td className="px-3 py-1.5 text-center text-slate-300 hidden sm:table-cell">{e.goalsAgainst}</td>
              <td className="px-3 py-1.5 text-center text-slate-300">
                {e.goalDifference > 0 ? `+${e.goalDifference}` : e.goalDifference}
              </td>
              <td className="px-3 py-1.5 text-center font-extrabold text-amber-300">{e.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-3 py-2 bg-black/20 border-t border-white/5 flex gap-4 text-[10px] font-mono">
        <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-emerald-500" /> Champions / UCL spots</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-rose-500" /> Relegation zone</span>
      </div>
    </div>
  );
}

function StandingsView() {
  const [activeSlug, setActiveSlug]   = useState("eng.1");
  const [activeName, setActiveName]   = useState("Premier League");
  const [entries, setEntries]         = useState<StandingsEntry[]>([]);
  const [standingsMeta, setMeta]      = useState<{ knockoutFormat?: boolean; message?: string } | null>(null);
  const [loading, setLoading]         = useState(true);
  const [search, setSearch]           = useState("");
  const [allLeagues, setAllLeagues]   = useState<Record<string, LeagueDef[]>>({});

  useEffect(() => {
    fetch("/api/leagues")
      .then((r) => r.json())
      .then((d: { byRegion: Record<string, LeagueDef[]> }) => setAllLeagues(d.byRegion ?? {}))
      .catch(() => {});
  }, []);

  // Fetch-only helper: all state updates happen asynchronously in the promise chain.
  const fetchStandings = useCallback((slug: string) => {
    fetch(`/api/standings?league=${slug}`)
      .then((r) => r.json())
      .then((d: { entries: StandingsEntry[]; knockoutFormat?: boolean; message?: string }) => {
        setEntries(d.entries ?? []);
        if (d.knockoutFormat || d.message) setMeta({ knockoutFormat: d.knockoutFormat, message: d.message });
      })
      .catch(() => { setEntries([]); })
      .finally(() => setLoading(false));
  }, []);

  const loadStandings = useCallback((slug: string, name: string) => {
    setActiveSlug(slug);
    setActiveName(name);
    setLoading(true);
    setMeta(null);
    fetchStandings(slug);
  }, [fetchStandings]);

  // Initial load — defaults (eng.1 / loading=true) are already set in state.
  useEffect(() => { fetchStandings("eng.1"); }, [fetchStandings]);

  // Filter leagues by search
  const filteredLeagues = useMemo(() => {
    if (!search.trim()) return allLeagues;
    const q = search.toLowerCase();
    const out: Record<string, LeagueDef[]> = {};
    for (const [region, lgs] of Object.entries(allLeagues)) {
      const m = lgs.filter((l) => l.name.toLowerCase().includes(q) || region.toLowerCase().includes(q));
      if (m.length) out[region] = m;
    }
    return out;
  }, [allLeagues, search]);

  // Quick-access popular leagues
  const QUICK = [
    { slug: "eng.1", name: "PL" }, { slug: "esp.1", name: "LaLiga" },
    { slug: "ger.1", name: "Bundesliga" }, { slug: "ita.1", name: "Serie A" },
    { slug: "fra.1", name: "Ligue 1" }, { slug: "ned.1", name: "Eredivisie" },
    { slug: "por.1", name: "Primeira Liga" }, { slug: "bra.1", name: "Brasileirão" },
    { slug: "arg.1", name: "Liga Pro" }, { slug: "mex.1", name: "Liga MX" },
    { slug: "usa.1", name: "MLS" }, { slug: "ksa.1", name: "Saudi PL" },
    { slug: "jpn.1", name: "J1 League" }, { slug: "sco.1", name: "SPL" },
    { slug: "bel.1", name: "Pro League" }, { slug: "tur.1", name: "Süper Lig" },
    { slug: "chn.1", name: "CSL" }, { slug: "kor.1", name: "K League" },
    { slug: "aus.1", name: "A-League" }, { slug: "rsa.1", name: "PSL" },
    { slug: "egy.1", name: "Egypt PL" }, { slug: "col.1", name: "Colombia" },
    { slug: "chi.1", name: "Chile" }, { slug: "per.1", name: "Peru" },
    { slug: "uae.1", name: "UAE" }, { slug: "qat.1", name: "Qatar" },
    { slug: "uefa.champions", name: "UCL" }, { slug: "uefa.europa", name: "UEL" },
    { slug: "conmebol.libertadores", name: "Libertadores" },
    { slug: "eng.2", name: "Championship" },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-black/50 rounded-lg p-4">
        <h2 className="text-base font-bold text-white">Standings</h2>
        <p className="text-xs text-slate-400 mt-0.5">243 leagues, cups & tournaments worldwide</p>
      </div>

      {/* Quick-access chips */}
      <div className="flex flex-wrap gap-1.5">
        {QUICK.map((lg) => (
          <button
            key={lg.slug}
            onClick={() => loadStandings(lg.slug, lg.name)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold border transition whitespace-nowrap ${
              activeSlug === lg.slug
                ? "bg-amber-400 text-slate-950 border-amber-400"
                : "border-white/15 bg-black/40 text-slate-300 hover:bg-black/60"
            }`}
          >
            {lg.name}
          </button>
        ))}
      </div>

      {/* Full league browser + standings panel */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        {/* Left: searchable league list */}
        <aside className="space-y-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search 243 leagues & cups…"
            className="w-full rounded-md border border-white/15 bg-black/50 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-400"
          />
          <div className="max-h-[65vh] overflow-y-auto space-y-2 pr-1 scrollbar-none">
            {Object.entries(filteredLeagues).map(([region, lgs]) => (
              <div key={region}>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-amber-300 font-mono px-1">{region}</div>
                <div className="space-y-px">
                  {lgs.map((lg) => (
                    <button
                      key={lg.slug}
                      onClick={() => loadStandings(lg.slug, lg.name)}
                      className={`w-full rounded px-2.5 py-1.5 text-left text-xs transition flex items-center justify-between gap-2 ${
                        activeSlug === lg.slug
                          ? "bg-amber-400/20 text-amber-200 font-bold"
                          : "text-slate-300 hover:bg-white/5"
                      }`}
                    >
                      <span className="truncate">{lg.name}</span>
                      <span className={`text-[9px] font-mono shrink-0 ${
                        lg.tier === 1 ? "text-amber-400" : lg.tier === 2 ? "text-slate-400" : "text-slate-600"
                      }`}>
                        {lg.tier === 1 ? "★" : lg.tier === 2 ? "◆" : "·"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {Object.keys(filteredLeagues).length === 0 && (
              <div className="text-center text-slate-500 text-sm py-6 font-mono">No leagues found</div>
            )}
          </div>
        </aside>

        {/* Right: standings table */}
        <div>
          {loading ? (
            <LoadingGrid label={`Loading ${activeName} standings…`} />
          ) : entries.length === 0 ? (
            <div className="bg-black/50 rounded-lg p-8 text-center">
              <div className="text-2xl mb-3">{standingsMeta?.knockoutFormat ? "🏆" : "📊"}</div>
              <div className="text-base font-bold text-slate-300 mb-2">{activeName}</div>
              {standingsMeta?.message ? (
                <p className="text-sm text-slate-400 font-mono max-w-md mx-auto">{standingsMeta.message}</p>
              ) : (
                <p className="text-sm text-slate-400 font-mono">
                  No standings data available. The season may not have started yet.
                  <br className="hidden sm:block" />
                  <span className="text-slate-500">Check the Fixtures tab for upcoming matches.</span>
                </p>
              )}
              <div className="mt-4 flex gap-2 justify-center">
                <button
                  onClick={() => { window.dispatchEvent(new CustomEvent("gigi-tab", { detail: "fixtures" })); }}
                  className="rounded-lg bg-amber-400/20 border border-amber-400/30 px-4 py-2 text-xs font-bold text-amber-300 hover:bg-amber-400/30 transition"
                >
                  View Fixtures →
                </button>
              </div>
            </div>
          ) : (
            <StandingsTable entries={entries} activeName={activeName} />
          )}
        </div>
      </div>
    </div>
  );
}

// --------------- MANUAL ORACLE ---------------
function ManualOracle() {
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FixtureLite[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedFx, setSelectedFx] = useState<FixtureLite | null>(null);

  useEffect(() => {
    // All state updates happen inside the debounce callback / promise chain,
    // never synchronously in the effect body.
    const timer = setTimeout(() => {
      if (query.length < 2) { setSearchResults([]); return; }
      setSearching(true);
      fetch(`/api/search?q=${encodeURIComponent(query)}`)
        .then((r) => r.json())
        .then((d: { results: FixtureLite[] }) => setSearchResults(d.results ?? []))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, query.length < 2 ? 0 : 400);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="space-y-4">
      <div className="bg-black/50 rounded-lg p-4">
        <h2 className="text-base font-bold text-white">Oracle Search</h2>
        <p className="text-xs text-slate-400 mt-1">Search for any team, league, or match to run the oracle</p>
      </div>

      <div className="relative">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search team, league or match... (e.g. Arsenal, World Cup, Barcelona)"
          className="w-full rounded-lg border border-white/15 bg-black/50 px-4 py-3 text-sm text-slate-100 outline-none focus:border-amber-400 font-mono"
        />
        {searching && (
          <div className="absolute right-3 top-3 text-xs text-amber-300 font-mono animate-pulse">Searching...</div>
        )}
      </div>

      {searchResults.length > 0 && !selectedFx && (
        <div className="bg-black/50 rounded-lg overflow-hidden divide-y divide-white/5">
          {searchResults.map((fx) => (
            <button
              key={`${fx.leagueSlug}-${fx.id}`}
              onClick={() => setSelectedFx(fx)}
              className="w-full text-left px-4 py-3 hover:bg-white/5 transition flex items-center gap-3"
            >
              {fx.home.logo && <Image src={fx.home.logo} alt="" width={20} height={20} className="object-contain" unoptimized />}
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white font-medium truncate">{fx.home.name} vs {fx.away.name}</div>
                <div className="text-[10px] text-slate-400 font-mono">{fx.leagueName} | {new Date(fx.date).toLocaleDateString()}</div>
              </div>
              {fx.state === "post" && fx.home.score !== null && (
                <span className="text-sm font-mono font-bold text-amber-300">{fx.home.score}-{fx.away.score}</span>
              )}
              <span className={`text-[10px] font-mono ${fx.state === "in" ? "text-rose-300" : fx.state === "pre" ? "text-emerald-300" : "text-slate-400"}`}>
                {fx.state === "in" ? "LIVE" : fx.state === "pre" ? "Upcoming" : "FT"}
              </span>
            </button>
          ))}
        </div>
      )}

      {query.length >= 2 && searchResults.length === 0 && !searching && (
        <div className="bg-black/50 rounded-lg p-6 text-center text-slate-400 text-sm font-mono">
          No matches found for &quot;{query}&quot;
        </div>
      )}

      {selectedFx && (
        <MatchDetail fixture={selectedFx} onClose={() => setSelectedFx(null)} />
      )}
    </div>
  );
}

// --------------- POST-MATCH VERIFICATION PAGE ---------------
interface VerifiedMatch {
  fixture: FixtureLite;
  hitCount: number;
  evaluatedCount: number;
  top10: Array<{
    name: string;
    selection: string;
    hitRate: number;
    outcome: string;
    reason?: string;
  }>;
}

function VerifiedPage() {
  const [matches, setMatches] = useState<VerifiedMatch[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/verify")
      .then((r) => r.json())
      .then((d: { verified: VerifiedMatch[] }) => setMatches(d.verified ?? []))
      .catch(() => setMatches([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingGrid label="Running post-match verification on recent finished matches…" />;

  if (matches.length === 0) {
    return (
      <div className="bg-black/50 rounded-lg p-10 text-center">
        <div className="text-lg font-bold text-slate-300 mb-2">No finished matches to verify</div>
        <p className="text-sm text-slate-400 font-mono">Check back after matches have been completed today.</p>
      </div>
    );
  }

  const totalHits = matches.reduce((s, m) => s + m.hitCount, 0);
  const totalEval = matches.reduce((s, m) => s + m.evaluatedCount, 0);

  return (
    <div className="space-y-8">
      <div className="bg-black/50 rounded-lg p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-extrabold text-emerald-300 font-mono flex items-center gap-2">
              POST-MATCH AUTOMATIC VERIFICATION
            </h2>
            <p className="text-xs text-slate-400 font-mono mt-1">
              Oracle predictions verified against real ESPN boxscore data (shots, SOT, corners, cards, offsides, saves)
            </p>
          </div>
          <div className="bg-black/40 rounded-lg px-5 py-3 text-center border border-emerald-500/30">
            <div className="text-3xl font-extrabold font-mono text-emerald-300">
              {totalHits}/{totalEval}
            </div>
            <div className="text-[10px] text-emerald-200 font-bold uppercase">
              OVERALL HIT RATE ({totalEval > 0 ? ((totalHits / totalEval) * 100).toFixed(0) : 0}%)
            </div>
          </div>
        </div>
      </div>

      {matches.map((vm) => {
        const pct = vm.evaluatedCount > 0 ? ((vm.hitCount / vm.evaluatedCount) * 100).toFixed(0) : "—";
        const perfect = vm.hitCount === vm.evaluatedCount && vm.evaluatedCount > 0;
        return (
          <div key={vm.fixture.id} className="bg-black/50 rounded-lg p-4">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3 pb-3 border-b border-white/10">
              <div className="flex items-center gap-3">
                {vm.fixture.home.logo && (
                  <Image src={vm.fixture.home.logo} alt={vm.fixture.home.shortName} width={24} height={24} className="object-contain" unoptimized />
                )}
                <span className="font-bold text-white">{vm.fixture.home.name}</span>
                <span className="font-mono text-xl font-extrabold text-amber-300">
                  {vm.fixture.home.score} - {vm.fixture.away.score}
                </span>
                <span className="font-bold text-white">{vm.fixture.away.name}</span>
                {vm.fixture.away.logo && (
                  <Image src={vm.fixture.away.logo} alt={vm.fixture.away.shortName} width={24} height={24} className="object-contain" unoptimized />
                )}
                <span className="text-xs text-slate-400 font-mono">{vm.fixture.leagueName}</span>
              </div>
              <div className={`rounded-lg px-3 py-1.5 font-mono text-center border ${
                perfect ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300" : "bg-amber-500/20 border-amber-500/40 text-amber-300"
              }`}>
                <div className="text-lg font-extrabold">{vm.hitCount}/{vm.evaluatedCount}</div>
                <div className="text-[9px] font-bold uppercase">{pct}% HIT</div>
              </div>
            </div>

            <div className="space-y-1.5">
              {vm.top10.map((pick, i) => {
                const badgeColor =
                  pick.outcome === "HIT" ? "text-emerald-300" :
                  pick.outcome === "MISS" ? "text-rose-300" : "text-slate-400";
                return (
                  <div key={i} className="flex items-center gap-3 rounded-md bg-black/30 px-3 py-2">
                    <span className="text-xs font-mono text-slate-500 w-5">{i + 1}.</span>
                    <span className={`text-sm ${badgeColor}`}>{pick.outcome}</span>
                    <span className="text-sm text-white font-medium flex-1">{pick.name}</span>
                    <span className="text-xs font-mono bg-emerald-500/10 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500/20">
                      {pick.selection}
                    </span>
                    <span className="text-xs font-mono text-slate-400">{(pick.hitRate * 100).toFixed(1)}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --------------- RESULTS PAGE ---------------
function ResultsPage({ onSelect }: { onSelect: (fx: FixtureLite) => void }) {
  const [results, setResults] = useState<FixtureLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);

  // Fetch-only helper: all state updates happen asynchronously in the promise chain.
  const fetchResults = useCallback((slug: string | null) => {
    const url = slug ? `/api/results?league=${slug}` : "/api/results";
    fetch(url)
      .then((r) => r.json())
      .then((d: { results: FixtureLite[] }) => setResults(d.results ?? []))
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  }, []);

  const loadResults = useCallback((slug: string | null) => {
    setActiveSlug(slug);
    setLoading(true);
    fetchResults(slug);
  }, [fetchResults]);

  // Initial load — defaults (slug=null / loading=true) are already set in state.
  useEffect(() => { fetchResults(null); }, [fetchResults]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => loadResults(null)}
          className={`rounded-full px-3 py-1 text-xs font-semibold border transition ${
            activeSlug === null ? "bg-amber-400 text-slate-950 border-amber-400" : "border-white/15 bg-black/40 text-slate-300 hover:bg-black/60"
          }`}
        >
          All Leagues
        </button>
        {TOP_LEAGUE_PILLS.map((lg) => (
          <button
            key={lg.slug}
            onClick={() => loadResults(lg.slug)}
            className={`rounded-full px-2.5 py-1 text-xs font-semibold border transition flex items-center gap-1.5 ${
              activeSlug === lg.slug ? "bg-amber-400 text-slate-950 border-amber-400" : "border-white/15 bg-black/40 text-slate-300 hover:bg-black/60"
            }`}
          >
            <Image src={lg.logo} alt={lg.name} width={14} height={14} className="object-contain" unoptimized />
            {lg.name}
          </button>
        ))}
      </div>

      {loading ? (
        <LoadingGrid label="Loading recent results…" />
      ) : results.length === 0 ? (
        <div className="bg-black/50 rounded-lg p-10 text-center">
          <div className="text-lg font-bold text-slate-300 mb-2">No recent results found</div>
          <p className="text-sm text-slate-400 font-mono">Try a different league or check back later.</p>
        </div>
      ) : (
        <div>
          <div className="mb-3 inline-block bg-black/60 rounded-lg px-3 py-1.5">
            <h2 className="text-sm font-bold text-white">Recent Results — {results.length} matches</h2>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {results.map((fx) => (
              <FixtureCard key={`res-${fx.leagueSlug}-${fx.id}`} fx={fx} onSelect={onSelect} />
            ))}
          </div>
          <p className="mt-4 text-center text-xs text-slate-500 font-mono">
            Tap any finished match → Deep Statistical Oracle + Post-Match Verification
          </p>
        </div>
      )}
    </div>
  );
}

// --------------- VALUE BETS PAGE ---------------
interface ValueBet {
  id: number; match: string; league: string; matchDate: string;
  marketName: string; selection: string; oracleProb: number;
  bookOdds: number; valueEdge: number; stake: number;
  potentialReturn: number; outcome: string; actualReturn: number | null; pnl: number | null;
}
interface ValueBetStats {
  total: number; won: number; lost: number; pending: number; settled: number;
  winRate: number; roi: number; totalStaked: number; totalReturns: number; totalPnl: number; avgEdge: number;
}

function ValueBetsPage() {
  const [bets, setBets]           = useState<ValueBet[]>([]);
  const [stats, setStats]         = useState<ValueBetStats | null>(null);
  const [loading, setLoading]     = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ settled: number; won: number; lost: number; totalPnl: number } | null>(null);

  // Fetch-only: all state updates happen asynchronously in the promise chain
  // (initial `loading` already defaults to true).
  const load = useCallback(() => {
    fetch("/api/value-bets").then(r => r.json()).then((d: { bets: ValueBet[]; stats: ValueBetStats }) => {
      setBets(d.bets ?? []); setStats(d.stats ?? null);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function verify() {
    setVerifying(true);
    try {
      const res = await fetch("/api/value-bets/verify", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { settled: number; won: number; lost: number; totalPnl: number };
      setVerifyResult(d);
      setLoading(true);
      load();
    } catch {
      setVerifyResult(null);
    } finally {
      setVerifying(false);
    }
  }

  if (loading) return <LoadingGrid label="Loading value bet tracker…" />;

  return (
    <div className="space-y-6">
      <div className="bg-black/50 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-white">💰 Value Bet Tracker</h2>
          <p className="text-xs text-slate-400 mt-1">Post-match P&L verification — oracle edge vs real outcomes</p>
        </div>
        <button onClick={verify} disabled={verifying}
          className="rounded-lg bg-emerald-500/20 border border-emerald-500/40 px-4 py-2 text-sm font-bold text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50 transition">
          {verifying ? "Verifying…" : "▶ Verify Pending"}
        </button>
      </div>

      {verifyResult && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 flex flex-wrap gap-4 text-sm font-mono">
          <span className="text-emerald-300">Settled: <strong>{verifyResult.settled}</strong></span>
          <span className="text-emerald-300">Won: <strong>{verifyResult.won}</strong></span>
          <span className="text-rose-300">Lost: <strong>{verifyResult.lost}</strong></span>
          <span className={(verifyResult.totalPnl ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"}>
            P&L: <strong>{(verifyResult.totalPnl ?? 0) >= 0 ? "+" : ""}{(verifyResult.totalPnl ?? 0).toFixed(2)}</strong>
          </span>
        </div>
      )}

      {stats && stats.total > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {[
            { label: "Total Bets",  val: String(stats.total),          color: "text-white" },
            { label: "Won",         val: String(stats.won),            color: "text-emerald-300" },
            { label: "Lost",        val: String(stats.lost),           color: "text-rose-300" },
            { label: "Pending",     val: String(stats.pending),        color: "text-amber-300" },
            { label: "Win Rate",    val: `${stats.winRate.toFixed(0)}%`, color: stats.winRate >= 55 ? "text-emerald-300" : "text-amber-300" },
            { label: "ROI",         val: `${stats.roi >= 0 ? "+" : ""}${stats.roi.toFixed(1)}%`, color: stats.roi >= 0 ? "text-emerald-300" : "text-rose-300" },
            { label: "Avg Edge",    val: `+${stats.avgEdge.toFixed(1)}%`, color: "text-cyan-300" },
          ].map((c) => (
            <div key={c.label} className="bg-black/50 rounded-lg p-3 text-center border border-white/5">
              <div className={`text-xl font-extrabold font-mono ${c.color}`}>{c.val}</div>
              <div className="text-[10px] text-slate-400 mt-0.5">{c.label}</div>
            </div>
          ))}
        </div>
      )}

      {bets.length === 0 ? (
        <div className="bg-black/50 rounded-lg p-10 text-center">
          <div className="text-2xl mb-3">💰</div>
          <div className="text-base font-bold text-slate-300 mb-2">No value bets tracked yet</div>
          <p className="text-xs text-slate-400 font-mono max-w-sm mx-auto">
            Value bets are automatically logged when you view a match in the Oracle and value bets are found.
            They&apos;re verified automatically after each match finishes.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <h3 className="text-sm font-bold text-white">{bets.length} tracked bets</h3>
            <div className="flex gap-3 text-xs font-mono">
              <span className="text-slate-400">Staked: <strong className="text-white">${(stats?.totalStaked ?? 0).toFixed(0)}</strong></span>
              <span className="text-slate-400">Returns: <strong className="text-emerald-300">${(stats?.totalReturns ?? 0).toFixed(0)}</strong></span>
              <span className="text-slate-400">P&L: <strong className={(stats?.totalPnl ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"}>{(stats?.totalPnl ?? 0) >= 0 ? "+" : ""}${(stats?.totalPnl ?? 0).toFixed(2)}</strong></span>
            </div>
          </div>
          <div className="bg-black/50 rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-black/30 text-[10px] uppercase text-slate-400 border-b border-white/5">
                <tr>
                  <th className="px-3 py-2 text-left">Match</th>
                  <th className="px-3 py-2 text-left">Market</th>
                  <th className="px-3 py-2 text-center">Edge</th>
                  <th className="px-3 py-2 text-center">Odds</th>
                  <th className="px-3 py-2 text-center">Stake</th>
                  <th className="px-3 py-2 text-center">Outcome</th>
                  <th className="px-3 py-2 text-right">P&L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {bets.map((b) => (
                  <tr key={b.id} className="hover:bg-white/[0.02]">
                    <td className="px-3 py-2">
                      <div className="text-slate-200 font-medium truncate max-w-[140px]">{b.match}</div>
                      <div className="text-[10px] text-slate-500 font-mono">{b.matchDate}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-slate-300 truncate max-w-[120px]">{b.marketName}</div>
                      <div className="text-[10px] text-amber-300 font-mono">{b.selection}</div>
                    </td>
                    <td className="px-3 py-2 text-center font-mono text-emerald-300 font-bold">+{(b.valueEdge*100).toFixed(1)}%</td>
                    <td className="px-3 py-2 text-center font-mono text-white">{b.bookOdds.toFixed(2)}</td>
                    <td className="px-3 py-2 text-center font-mono text-slate-300">${b.stake}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`rounded px-2 py-0.5 text-[10px] font-bold font-mono ${
                        b.outcome === "won"     ? "bg-emerald-500/20 text-emerald-300" :
                        b.outcome === "lost"    ? "bg-rose-500/20 text-rose-300" :
                        b.outcome === "void"    ? "bg-slate-600/40 text-slate-400" :
                                                  "bg-amber-500/20 text-amber-300"
                      }`}>{b.outcome.toUpperCase()}</span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-bold">
                      {b.pnl !== null ? (
                        <span className={b.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}>
                          {b.pnl >= 0 ? "+" : ""}${b.pnl.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// --------------- BACKTEST DASHBOARD ---------------
interface BacktestTop1 { pick: string; selection: string; hitRate: number; outcome: string }
interface BacktestPickEntry { pick: string; selection: string; outcome: string }
interface BacktestMatch {
  match: string; league: string; score: string; date: string;
  top1: BacktestTop1;
  top3: BacktestPickEntry[]; top5: BacktestPickEntry[]; top10: BacktestPickEntry[];
  top1Hit: boolean;
  top3Hits: number; top3Total: number; top3Perfect: boolean;
  top5Hits: number; top5Total: number; top5Perfect: boolean;
  top10Hits: number; top10Total: number; top10Perfect: boolean;
  boxscoreAvailable: boolean; dataCompleteness: number;
}
interface BacktestAggregate {
  matchesAnalysed: number; daysWindow: number;
  top1:  { matchesWithPick: number; matchesEmpty: number; hits: number; hitRate: number; hitRatePct: string };
  top3:  { settled: number; perfectMatches: number; perfectRate: number; avgHits: number; totalHits: number; totalPicks: number };
  top5:  { settled: number; perfectMatches: number; perfectRate: number; avgHits: number; totalHits: number; totalPicks: number };
  top10: { settled: number; perfectMatches: number; perfectRate: number; avgHits: number; totalHits: number; totalPicks: number; overallAccuracy: number };
}

// Hoisted out of BacktestDashboard so they aren't re-created on every render
function AccuracyBadge({ pct, label }: { pct: number; label: string }) {
  const color = pct >= 0.90 ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/10"
              : pct >= 0.75 ? "text-amber-300 border-amber-500/40 bg-amber-500/10"
              : "text-rose-300 border-rose-500/40 bg-rose-500/10";
  return (
    <div className={`rounded-lg border px-4 py-3 text-center ${color}`}>
      <div className="text-3xl font-extrabold font-mono">{(pct * 100).toFixed(1)}%</div>
      <div className="text-[10px] font-bold uppercase mt-0.5">{label}</div>
    </div>
  );
}

function OutcomePill({ outcome }: { outcome: string }) {
  if (outcome === "HIT")     return <span className="rounded bg-emerald-500/20 border border-emerald-500/40 px-2 py-0.5 text-[10px] font-bold text-emerald-300 font-mono">HIT</span>;
  if (outcome === "MISS")    return <span className="rounded bg-rose-500/20 border border-rose-500/40 px-2 py-0.5 text-[10px] font-bold text-rose-300 font-mono">MISS</span>;
  if (outcome === "EMPTY")   return <span className="rounded bg-slate-700/50 border border-slate-600/40 px-2 py-0.5 text-[10px] font-bold text-slate-400 font-mono">EMPTY</span>;
  return <span className="rounded bg-slate-700/50 border border-slate-600/40 px-2 py-0.5 text-[10px] font-bold text-slate-500 font-mono">—</span>;
}

function BacktestDashboard() {
  const [loading, setLoading]     = useState(false);
  const [ran, setRan]             = useState(false);
  const [aggregate, setAggregate] = useState<BacktestAggregate | null>(null);
  const [matches, setMatches]     = useState<BacktestMatch[]>([]);
  const [days, setDays]           = useState(7);
  const [limit, setLimit]         = useState(20);
  const [leagueFilter, setLeagueFilter] = useState("");
  const [expandedMatch, setExpandedMatch] = useState<string | null>(null);
  const [error, setError]         = useState<string | null>(null);

  const LEAGUES_QUICK = [
    { slug: "", name: "All Leagues" },
    { slug: "eng.1", name: "PL" }, { slug: "esp.1", name: "LaLiga" },
    { slug: "ger.1", name: "Bundesliga" }, { slug: "ita.1", name: "Serie A" },
    { slug: "fra.1", name: "Ligue 1" }, { slug: "ned.1", name: "Eredivisie" },
    { slug: "usa.1", name: "MLS" }, { slug: "bra.1", name: "Brasileirão" },
    { slug: "arg.1", name: "Liga Pro" }, { slug: "mex.1", name: "Liga MX" },
    { slug: "sco.1", name: "SPL" }, { slug: "tur.1", name: "Süper Lig" },
    { slug: "ksa.1", name: "Saudi PL" }, { slug: "bel.1", name: "Pro League" },
  ];

  async function runBacktest() {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ days: String(days), limit: String(limit) });
      if (leagueFilter) params.set("league", leagueFilter);
      const res = await fetch(`/api/backtest-live?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { aggregate: BacktestAggregate; matches: BacktestMatch[] };
      setAggregate(data.aggregate);
      setMatches(data.matches);
      setRan(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backtest failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-black/50 rounded-lg p-4">
        <h2 className="text-base font-bold text-white flex items-center gap-2">
          <span className="text-amber-400">⚡</span> Live Backtest Engine
        </h2>
        <p className="text-xs text-slate-400 mt-1">
          Runs the oracle on real finished matches, evaluates every pick against actual ESPN boxscore data.
          This is the ground-truth accuracy measurement — no simulation, no invented data.
        </p>
      </div>

      {/* Controls */}
      <div className="bg-black/50 rounded-lg p-4 space-y-4">
        <div className="flex flex-wrap gap-3 items-center">
          {/* Days */}
          <div>
            <div className="text-[10px] text-slate-400 font-mono mb-1">TIME WINDOW</div>
            <div className="flex gap-1">
              {[3, 7, 14, 30].map((d) => (
                <button key={d} onClick={() => setDays(d)}
                  className={`rounded px-3 py-1.5 text-xs font-bold transition ${days === d ? "bg-amber-400 text-slate-950" : "bg-black/40 text-slate-300 border border-white/15"}`}>
                  {d}d
                </button>
              ))}
            </div>
          </div>
          {/* Matches limit */}
          <div>
            <div className="text-[10px] text-slate-400 font-mono mb-1">MAX MATCHES</div>
            <div className="flex gap-1">
              {[10, 20, 30, 50].map((l) => (
                <button key={l} onClick={() => setLimit(l)}
                  className={`rounded px-3 py-1.5 text-xs font-bold transition ${limit === l ? "bg-amber-400 text-slate-950" : "bg-black/40 text-slate-300 border border-white/15"}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* League filter */}
        <div>
          <div className="text-[10px] text-slate-400 font-mono mb-1">LEAGUE FILTER</div>
          <div className="flex flex-wrap gap-1.5">
            {LEAGUES_QUICK.map((l) => (
              <button key={l.slug} onClick={() => setLeagueFilter(l.slug)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold border transition ${leagueFilter === l.slug ? "bg-amber-400 text-slate-950 border-amber-400" : "border-white/15 bg-black/40 text-slate-300 hover:bg-black/60"}`}>
                {l.name}
              </button>
            ))}
          </div>
        </div>

        <button onClick={runBacktest} disabled={loading}
          className="rounded-lg bg-emerald-500 px-6 py-3 text-sm font-bold text-white hover:bg-emerald-400 disabled:opacity-50 transition flex items-center gap-2">
          {loading ? (
            <><span className="animate-spin">⚡</span> Running Backtest…</>
          ) : (
            <><span>▶</span> Run Backtest</>
          )}
        </button>
        {error && <p className="text-rose-400 text-xs font-mono">Error: {error}</p>}
      </div>

      {/* Results */}
      {ran && aggregate && (
        <>
          {/* Summary cards */}
          <div className="bg-black/50 rounded-lg p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">
                Results — {aggregate.matchesAnalysed} matches · last {aggregate.daysWindow} days
              </h3>
              <span className="text-[10px] text-slate-400 font-mono">
                {matches.filter((m) => m.boxscoreAvailable).length}/{aggregate.matchesAnalysed} with full boxscore
              </span>
            </div>

            {/* Tier accuracy grid */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <AccuracyBadge pct={aggregate.top1.hitRate}  label={`Top 1 (${aggregate.top1.hits}/${aggregate.top1.matchesWithPick})`} />
              <AccuracyBadge pct={aggregate.top3.totalPicks > 0 ? aggregate.top3.totalHits / aggregate.top3.totalPicks : 0}  label={`Top 3 Avg ${aggregate.top3.avgHits.toFixed(1)}/3`} />
              <AccuracyBadge pct={aggregate.top5.totalPicks > 0 ? aggregate.top5.totalHits / aggregate.top5.totalPicks : 0}  label={`Top 5 Avg ${aggregate.top5.avgHits.toFixed(1)}/5`} />
              <AccuracyBadge pct={aggregate.top10.overallAccuracy} label={`Top 10 Avg ${aggregate.top10.avgHits.toFixed(1)}/10`} />
            </div>

            {/* Perfect rates */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Top-3 Perfect (3/3)", rate: aggregate.top3.perfectRate,  n: aggregate.top3.perfectMatches,  total: aggregate.top3.settled },
                { label: "Top-5 Perfect (5/5)", rate: aggregate.top5.perfectRate,  n: aggregate.top5.perfectMatches,  total: aggregate.top5.settled },
                { label: "Top-10 Perfect (10/10)",rate: aggregate.top10.perfectRate, n: aggregate.top10.perfectMatches, total: aggregate.top10.settled },
              ].map((t) => (
                <div key={t.label} className="bg-black/40 rounded-lg p-3 text-center border border-white/5">
                  <div className={`text-2xl font-extrabold font-mono ${t.rate >= 0.5 ? "text-emerald-300" : t.rate >= 0.3 ? "text-amber-300" : "text-rose-300"}`}>
                    {(t.rate * 100).toFixed(0)}%
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">{t.label}</div>
                  <div className="text-[10px] text-slate-500 font-mono">{t.n}/{t.total} matches</div>
                </div>
              ))}
            </div>

            {/* Top-1 detail */}
            <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3">
              <div className="text-xs font-bold text-emerald-300 font-mono mb-2">TOP-1 BULLETPROOF GATE ANALYSIS</div>
              <div className="flex flex-wrap gap-4 text-xs font-mono">
                <span>Picks issued: <strong className="text-white">{aggregate.top1.matchesWithPick}</strong></span>
                <span>Empty (no safe pick): <strong className="text-amber-300">{aggregate.top1.matchesEmpty}</strong></span>
                <span>Hits: <strong className="text-emerald-300">{aggregate.top1.hits}</strong></span>
                <span>Misses: <strong className="text-rose-300">{aggregate.top1.matchesWithPick - aggregate.top1.hits}</strong></span>
                <span>Hit rate: <strong className={aggregate.top1.hitRate >= 0.90 ? "text-emerald-300" : "text-amber-300"}>{aggregate.top1.hitRatePct}</strong></span>
              </div>
              <div className="mt-2 h-2 bg-black/40 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${aggregate.top1.hitRate >= 0.90 ? "bg-emerald-500" : aggregate.top1.hitRate >= 0.75 ? "bg-amber-500" : "bg-rose-500"}`}
                  style={{ width: `${aggregate.top1.hitRate * 100}%` }} />
              </div>
              {aggregate.top1.hitRate >= 0.90
                ? <p className="text-emerald-400 text-[10px] font-mono mt-1">✓ Target achieved — Top-1 hitting ≥90%</p>
                : aggregate.top1.hitRate >= 0.80
                ? <p className="text-amber-400 text-[10px] font-mono mt-1">⚠ Close — Top-1 needs more calibration to reach 90%+</p>
                : <p className="text-rose-400 text-[10px] font-mono mt-1">✗ Below target — Top-1 calibration needs improvement</p>
              }
            </div>
          </div>

          {/* Match-by-match breakdown */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">Match-by-Match Breakdown</h3>
              <span className="text-[10px] text-slate-500 font-mono">Click any match to expand picks</span>
            </div>

            {matches.map((m, idx) => {
              const isExpanded = expandedMatch === `${idx}`;
              const top1Color = m.top1.outcome === "HIT" ? "border-l-emerald-500"
                             : m.top1.outcome === "MISS" ? "border-l-rose-500"
                             : m.top1.outcome === "EMPTY" ? "border-l-slate-600"
                             : "border-l-amber-500";

              return (
                <div key={idx} className={`bg-black/50 rounded-lg border-l-2 ${top1Color} overflow-hidden`}>
                  <button
                    onClick={() => setExpandedMatch(isExpanded ? null : `${idx}`)}
                    className="w-full text-left p-3 hover:bg-white/[0.02] transition"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-3">
                        <div>
                          <div className="text-sm font-bold text-white">{m.match}</div>
                          <div className="text-[10px] text-slate-400 font-mono">{m.league} · {m.date} · {m.score}</div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-wrap">
                        {/* Top-1 */}
                        <div className="text-center">
                          <div className="text-[9px] text-slate-500 font-mono">T1</div>
                          <OutcomePill outcome={m.top1.outcome} />
                        </div>
                        {/* Top-3 */}
                        <div className="text-center">
                          <div className="text-[9px] text-slate-500 font-mono">T3</div>
                          <span className={`text-xs font-bold font-mono ${m.top3Perfect ? "text-emerald-300" : m.top3Hits === m.top3Total && m.top3Total > 0 ? "text-emerald-300" : m.top3Hits > 0 ? "text-amber-300" : "text-rose-300"}`}>
                            {m.top3Hits}/{m.top3Total}
                          </span>
                        </div>
                        {/* Top-5 */}
                        <div className="text-center">
                          <div className="text-[9px] text-slate-500 font-mono">T5</div>
                          <span className={`text-xs font-bold font-mono ${m.top5Perfect ? "text-emerald-300" : m.top5Hits >= m.top5Total * 0.8 ? "text-amber-300" : "text-rose-300"}`}>
                            {m.top5Hits}/{m.top5Total}
                          </span>
                        </div>
                        {/* Top-10 */}
                        <div className="text-center">
                          <div className="text-[9px] text-slate-500 font-mono">T10</div>
                          <span className={`text-xs font-bold font-mono ${m.top10Perfect ? "text-emerald-300" : m.top10Hits >= m.top10Total * 0.8 ? "text-amber-300" : "text-rose-300"}`}>
                            {m.top10Hits}/{m.top10Total}
                          </span>
                        </div>
                        <span className={`text-[9px] font-mono ${m.boxscoreAvailable ? "text-emerald-500" : "text-slate-600"}`}>
                          {m.boxscoreAvailable ? "📊" : "—"}
                        </span>
                      </div>
                    </div>

                    {/* Top-1 pick preview */}
                    {m.top1.outcome !== "EMPTY" && (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-[9px] text-slate-500 font-mono">TOP-1:</span>
                        <span className="text-[11px] text-white font-medium truncate">{m.top1.pick}</span>
                        <span className="text-[10px] text-amber-300 font-mono">{m.top1.selection}</span>
                        <span className="text-[10px] text-slate-400 font-mono">({(m.top1.hitRate * 100).toFixed(1)}%)</span>
                        <OutcomePill outcome={m.top1.outcome} />
                      </div>
                    )}
                    {m.top1.outcome === "EMPTY" && (
                      <div className="mt-1 text-[10px] text-slate-500 font-mono">
                        TOP-1: No pick issued — bulletproof gate found nothing safe enough
                      </div>
                    )}
                  </button>

                  {/* Expanded pick details */}
                  {isExpanded && (
                    <div className="border-t border-white/5 p-3 space-y-3">
                      {[
                        { label: "TOP-1", picks: m.top1.outcome !== "EMPTY" ? [m.top1] : [], color: "emerald" },
                        { label: "TOP-3", picks: m.top3, color: "amber" },
                        { label: "TOP-5", picks: m.top5, color: "cyan" },
                        { label: "TOP-10", picks: m.top10, color: "slate" },
                      ].map(({ label, picks }) => (
                        <div key={label}>
                          <div className="text-[10px] text-slate-400 font-mono mb-1">{label}</div>
                          <div className="space-y-1">
                            {picks.length === 0
                              ? <div className="text-[10px] text-slate-600 font-mono italic">No pick issued</div>
                              : picks.map((p, pi) => (
                                <div key={pi} className="flex items-center gap-2 bg-black/30 rounded px-2 py-1.5 text-xs">
                                  <span className="font-mono text-slate-500 w-4">{pi + 1}.</span>
                                  <span className="text-white flex-1 truncate">{p.pick}</span>
                                  <span className="text-amber-300 font-mono text-[10px]">{p.selection}</span>
                                  <OutcomePill outcome={p.outcome} />
                                </div>
                              ))
                            }
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {!ran && !loading && (
        <div className="bg-black/50 rounded-lg p-12 text-center">
          <div className="text-4xl mb-4">⚡</div>
          <div className="text-lg font-bold text-slate-300 mb-2">Backtest Engine Ready</div>
          <p className="text-sm text-slate-400 font-mono max-w-md mx-auto">
            Configure the window and league above, then click Run Backtest.
            The engine will fetch real finished matches, run the oracle on each,
            and evaluate every pick against the actual ESPN boxscore data.
          </p>
          <p className="text-xs text-slate-500 font-mono mt-3">
            Tip: Start with 7 days, 20 matches to get results quickly (~30s).
          </p>
        </div>
      )}
    </div>
  );
}

// --------------- PERFORMANCE DASHBOARD ---------------
interface PerfData {
  totalMatches: number;
  totalPicks: number;
  totalHits: number;
  totalMisses: number;
  totalPending: number;
  totalVerified: number;
  overallAccuracy: number;
  perfectMatches: number;
  currentStreak: number;
  streakType: "W" | "L" | null;
  top1: { hits: number; total: number; accuracy: number };
  top3: { hits: number; total: number; accuracy: number };
  top10: { hits: number; total: number; accuracy: number };
  tierSweep?: { top1: number; top3: number; top5: number; top10: number; counts: { top1: number; top3: number; top5: number; top10: number } };
  bestMatch: { matchLabel: string; score: string; accuracy: number; hits: number; total: number } | null;
  leagueBreakdown: Array<{ league: string; hits: number; misses: number; matches: number; accuracy: number }>;
  // /api/performance returns per-type accumulator stats: { all, highHit, value }
  accumulatorPerformance: { all: AccaStats; highHit: AccaStats; value: AccaStats } | null;
  recentMatches: Array<{
    id: number;
    matchLabel: string;
    league: string;
    matchDate: string;
    homeScore: number;
    awayScore: number;
    hits: number;
    misses: number;
    pending: number;
    accuracy: number;
    totalPicks: number;
    top10Detail: Array<{ name: string; selection: string; outcome: string }>;
  }>;
}

function PerformanceDashboard() {
  const [data, setData]           = useState<PerfData | null>(null);
  const [loading, setLoading]     = useState(true);
  const [accuracy, setAccuracy]   = useState<{ cumulative?: { accuracy: number; accuracyPct: string; matches: number; trend: string }; rolling7d?: { accuracyPct: string }; daily?: Array<{ date: string; accuracy: number; matches: number }> } | null>(null);
  const [calibData, setCalibData] = useState<{ families?: Array<{ family: string; observedPct: string; currentCoeff: number; suggestedCoeff: number; action: string; total: number }> } | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<"overview" | "accuracy" | "calibration">("overview");
  const [resolvingId, setResolvingId]   = useState<number | null>(null);

  const refreshPerformance = useCallback(() => {
    return fetch("/api/performance")
      .then((r) => r.json())
      .then((d: PerfData) => setData(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/performance").then((r) => r.json()).then((d: PerfData) => setData(d)).catch(() => setData(null)).finally(() => setLoading(false));
    fetch("/api/accuracy?days=30").then((r) => r.json()).then(setAccuracy).catch(() => {});
    fetch("/api/calibrate").then((r) => r.json()).then(setCalibData).catch(() => {});
  }, []);

  if (loading) return <LoadingGrid label="Loading performance records..." />;

  if (!data || data.totalMatches === 0) {
    return (
      <div className="space-y-6">
        <div className="bg-black/50 rounded-lg p-4">
          <h2 className="text-base font-bold text-white">ORACLE PERFORMANCE TRACKER</h2>
          <p className="text-xs text-slate-400 mt-1">Track record of every post-match verification</p>
        </div>
        <div className="bg-black/50 rounded-lg p-10 text-center">
          <div className="text-lg font-bold text-slate-300 mb-2">No verified matches yet</div>
          <p className="text-sm text-slate-400 font-mono">
            Tap any finished match to run the oracle. Post-match verification results will appear here.
          </p>
        </div>
      </div>
    );
  }

  // Combined stats across all slip types (the API returns { all, highHit, value })
  const accaPerf = data.accumulatorPerformance?.all ?? null;

  return (
    <div className="space-y-6">
      <div className="bg-black/50 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-white">ORACLE PERFORMANCE TRACKER</h2>
          <p className="text-xs text-slate-400 mt-1">
            Track record across {data.totalMatches} verified match{data.totalMatches > 1 ? "es" : ""}
            {accuracy?.cumulative && <span className="ml-2 text-emerald-400 font-mono">{accuracy.cumulative.trend}</span>}
          </p>
        </div>
        <div className="flex gap-1.5">
          {(["overview","accuracy","calibration"] as const).map((t) => (
            <button key={t} onClick={() => setActiveSubTab(t)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold capitalize transition ${activeSubTab===t ? "bg-amber-400 text-slate-950" : "bg-black/50 text-slate-300 border border-white/10 hover:bg-black/70"}`}>
              {t === "overview" ? "Overview" : t === "accuracy" ? "📈 Accuracy Trend" : "🔧 Calibration"}
            </button>
          ))}
        </div>
      </div>

      {activeSubTab === "accuracy" && accuracy && (
        <div className="space-y-4">
          {/* Accuracy summary cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="bg-black/50 rounded-lg p-3 text-center border border-emerald-500/20">
              <div className={`text-2xl font-extrabold font-mono ${(accuracy.cumulative?.accuracy ?? 0) >= 0.90 ? "text-emerald-300" : (accuracy.cumulative?.accuracy ?? 0) >= 0.75 ? "text-amber-300" : "text-rose-300"}`}>
                {accuracy.cumulative?.accuracyPct ?? "—"}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">30-Day Accuracy</div>
            </div>
            <div className="bg-black/50 rounded-lg p-3 text-center">
              <div className="text-2xl font-extrabold font-mono text-cyan-300">{accuracy.rolling7d?.accuracyPct ?? "—"}</div>
              <div className="text-[10px] text-slate-400 mt-0.5">Last 7 Days</div>
            </div>
            <div className="bg-black/50 rounded-lg p-3 text-center">
              <div className="text-2xl font-extrabold font-mono text-white">{accuracy.cumulative?.matches ?? 0}</div>
              <div className="text-[10px] text-slate-400 mt-0.5">Matches Logged</div>
            </div>
            <div className="bg-black/50 rounded-lg p-3 text-center">
              <div className={`text-lg font-extrabold font-mono ${accuracy.cumulative?.trend?.includes("↑") ? "text-emerald-300" : accuracy.cumulative?.trend?.includes("↓") ? "text-rose-300" : "text-amber-300"}`}>
                {accuracy.cumulative?.trend ?? "—"}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">Trend</div>
            </div>
          </div>
          {/* Daily bar chart (text-based) */}
          {accuracy.daily && accuracy.daily.length > 0 && (
            <div className="bg-black/50 rounded-lg p-4">
              <div className="text-xs font-bold text-white font-mono mb-3">DAILY ACCURACY (last 30 days)</div>
              <div className="flex items-end gap-1 h-20">
                {accuracy.daily.slice(-30).map((day, i) => {
                  const pct = day.accuracy;
                  const h   = Math.round(pct * 80);
                  const col = pct >= 0.90 ? "bg-emerald-500" : pct >= 0.75 ? "bg-amber-500" : pct >= 0.60 ? "bg-orange-500" : "bg-rose-500";
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center gap-0.5" title={`${day.date}: ${(pct*100).toFixed(0)}% (${day.matches} matches)`}>
                      <div className={`w-full rounded-t ${col} opacity-80 hover:opacity-100 transition`} style={{ height: `${Math.max(4, h)}px` }} />
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between text-[9px] text-slate-500 font-mono mt-1">
                <span>{accuracy.daily[Math.max(0, accuracy.daily.length-30)]?.date}</span>
                <span>{accuracy.daily[accuracy.daily.length-1]?.date}</span>
              </div>
              <div className="flex gap-3 mt-2 text-[10px] font-mono">
                <span className="flex items-center gap-1"><span className="w-2 h-2 bg-emerald-500 rounded inline-block"/> ≥90%</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 bg-amber-500 rounded inline-block"/> ≥75%</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 bg-rose-500 rounded inline-block"/> &lt;60%</span>
              </div>
            </div>
          )}
        </div>
      )}

      {activeSubTab === "calibration" && calibData && (
        <div className="space-y-4">
          <div className="bg-black/50 rounded-lg p-4">
            <div className="text-xs font-bold text-white font-mono mb-3">
              SELF-TUNING CALIBRATION — Empirical vs Model Reliability
            </div>
            <p className="text-[11px] text-slate-400 mb-3">
              Based on {calibData.families?.reduce((s,f)=>s+f.total,0) ?? 0} verified picks from performance log.
              Green = increase reliability, Red = decrease, Grey = stable.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead className="text-[10px] uppercase text-slate-400 border-b border-white/10">
                  <tr>
                    <th className="text-left py-2 px-2">Family</th>
                    <th className="text-center py-2">Picks</th>
                    <th className="text-center py-2">Observed</th>
                    <th className="text-center py-2">Current</th>
                    <th className="text-center py-2">Suggested</th>
                    <th className="text-center py-2">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {(calibData.families ?? []).map((f) => (
                    <tr key={f.family} className="hover:bg-white/[0.02]">
                      <td className="py-2 px-2 text-slate-200 font-medium">{f.family}</td>
                      <td className="py-2 text-center text-slate-400">{f.total}</td>
                      <td className="py-2 text-center font-bold text-white">{f.observedPct}</td>
                      <td className="py-2 text-center text-slate-400">{f.currentCoeff.toFixed(2)}</td>
                      <td className="py-2 text-center text-amber-300">{f.suggestedCoeff.toFixed(2)}</td>
                      <td className="py-2 text-center">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${f.action.includes("INCREASE") ? "bg-emerald-500/20 text-emerald-300" : f.action.includes("DECREASE") ? "bg-rose-500/20 text-rose-300" : "bg-slate-700/50 text-slate-400"}`}>
                          {f.action}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Overall Accuracy" value={`${(data.overallAccuracy * 100).toFixed(1)}%`} sub={`${data.totalHits}H ${data.totalMisses}M / ${data.totalVerified} verified`} color={data.overallAccuracy >= 0.8 ? "text-emerald-300" : data.overallAccuracy >= 0.6 ? "text-amber-300" : "text-rose-300"} />
        <StatCard label="Total Matches" value={String(data.totalMatches)} sub={`${data.perfectMatches} perfect, ${data.totalMatches - data.perfectMatches} with misses`} color="text-amber-300" />
        <StatCard label="Picks Breakdown" value={`${data.totalHits}H / ${data.totalMisses}M`} sub={`${data.totalPending} pending to resolve`} color="text-white" />
        <StatCard label="Current Streak" value={`${data.currentStreak}${data.streakType ?? ""}`} sub={data.streakType === "W" ? "consecutive perfect" : data.streakType === "L" ? "consecutive with misses" : "no data"} color={data.streakType === "W" ? "text-emerald-300" : "text-rose-300"} />
      </div>

      {data.tierSweep && (
        <div>
          <div className="mb-2 inline-block bg-black/60 rounded-lg px-3 py-1.5">
            <h3 className="text-sm font-bold text-white">Tier Win Rate <span className="text-slate-400 font-normal">— clean-sweep (all legs hit)</span></h3>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { key: "top1" as const, label: "TOP 1", desc: "Single safest pick" },
              { key: "top3" as const, label: "TOP 3", desc: "Safest treble" },
              { key: "top5" as const, label: "TOP 5", desc: "Safest 5-fold" },
              { key: "top10" as const, label: "TOP 10", desc: "Full slip" },
            ].map((t) => {
              const rate = data.tierSweep![t.key];
              const n = data.tierSweep!.counts[t.key];
              const color = rate >= 0.9 ? "text-emerald-300" : rate >= 0.75 ? "text-cyan-300" : rate >= 0.6 ? "text-amber-300" : "text-rose-300";
              const bar = rate >= 0.9 ? "bg-emerald-500" : rate >= 0.75 ? "bg-cyan-500" : rate >= 0.6 ? "bg-amber-500" : "bg-rose-500";
              return (
                <div key={t.key} className="bg-black/50 rounded-lg p-4">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs font-bold text-white font-mono">{t.label}</span>
                    <span className={`text-2xl font-extrabold font-mono ${color}`}>{n > 0 ? `${(rate * 100).toFixed(0)}%` : "—"}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">{t.desc}</div>
                  <div className="mt-2 h-2 bg-black/40 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${bar}`} style={{ width: `${rate * 100}%` }} />
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1 font-mono">{n} settled</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {data.top1.total > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-black/50 rounded-lg p-4">
            <div className="text-xs text-slate-400 font-mono mb-1">TOP 1 PICK ACCURACY</div>
            <div className={`text-2xl font-extrabold font-mono ${data.top1.accuracy >= 0.8 ? "text-emerald-300" : data.top1.accuracy >= 0.6 ? "text-amber-300" : "text-rose-300"}`}>
              {(data.top1.accuracy * 100).toFixed(0)}%
            </div>
            <div className="text-[10px] text-slate-400 mt-1">{data.top1.hits} hit / {data.top1.total - data.top1.hits} miss across {data.top1.total} matches</div>
            <div className="mt-2 h-2 bg-black/40 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${data.top1.accuracy * 100}%` }} />
            </div>
          </div>
          <div className="bg-black/50 rounded-lg p-4">
            <div className="text-xs text-slate-400 font-mono mb-1">TOP 3 PICKS ACCURACY</div>
            <div className={`text-2xl font-extrabold font-mono ${data.top3.accuracy >= 0.8 ? "text-emerald-300" : data.top3.accuracy >= 0.6 ? "text-amber-300" : "text-rose-300"}`}>
              {(data.top3.accuracy * 100).toFixed(0)}%
            </div>
            <div className="text-[10px] text-slate-400 mt-1">{data.top3.hits} hit / {data.top3.total - data.top3.hits} miss across {data.top3.total} picks</div>
            <div className="mt-2 h-2 bg-black/40 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${data.top3.accuracy * 100}%` }} />
            </div>
          </div>
          <div className="bg-black/50 rounded-lg p-4">
            <div className="text-xs text-slate-400 font-mono mb-1">TOP 10 PICKS ACCURACY</div>
            <div className={`text-2xl font-extrabold font-mono ${data.top10.accuracy >= 0.8 ? "text-emerald-300" : data.top10.accuracy >= 0.6 ? "text-amber-300" : "text-rose-300"}`}>
              {(data.top10.accuracy * 100).toFixed(0)}%
            </div>
            <div className="text-[10px] text-slate-400 mt-1">{data.top10.hits} hit / {data.top10.total - data.top10.hits} miss across {data.top10.total} picks</div>
            <div className="mt-2 h-2 bg-black/40 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${data.top10.accuracy * 100}%` }} />
            </div>
          </div>
        </div>
      )}

      {data.leagueBreakdown.length > 0 && (
        <div>
          <div className="mb-2 inline-block bg-black/60 rounded-lg px-3 py-1.5">
            <h3 className="text-sm font-bold text-white">Accuracy by League</h3>
          </div>
          <div className="bg-black/50 rounded-lg overflow-hidden">
            <table className="w-full text-sm font-mono">
              <thead className="bg-black/30 text-[11px] uppercase text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left">League</th>
                  <th className="px-3 py-2 text-center">Matches</th>
                  <th className="px-3 py-2 text-center">Hits</th>
                  <th className="px-3 py-2 text-center">Misses</th>
                  <th className="px-3 py-2 text-right">Accuracy</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {data.leagueBreakdown.map((lg) => (
                  <tr key={lg.league}>
                    <td className="px-3 py-2 text-slate-200 font-medium">{lg.league}</td>
                    <td className="px-3 py-2 text-center text-slate-300">{lg.matches}</td>
                    <td className="px-3 py-2 text-center text-emerald-300">{lg.hits}</td>
                    <td className="px-3 py-2 text-center text-rose-300">{lg.misses}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={lg.accuracy >= 0.8 ? "text-emerald-300 font-bold" : lg.accuracy >= 0.6 ? "text-amber-300" : "text-rose-300"}>
                        {(lg.accuracy * 100).toFixed(0)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {accaPerf && accaPerf.total > 0 && (
        <div>
          <div className="mb-2 inline-block bg-black/60 rounded-lg px-3 py-1.5">
            <h3 className="text-sm font-bold text-white">Accumulator Performance</h3>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 mb-3">
            <div className="bg-black/50 rounded-lg p-3 text-center">
              <div className="text-xl font-extrabold font-mono text-amber-300">{accaPerf.total}</div>
              <div className="text-[10px] text-slate-400">Total Slips</div>
            </div>
            <div className="bg-black/50 rounded-lg p-3 text-center">
              <div className="text-xl font-extrabold font-mono text-emerald-300">{accaPerf.won}</div>
              <div className="text-[10px] text-slate-400">Won</div>
            </div>
            <div className="bg-black/50 rounded-lg p-3 text-center">
              <div className="text-xl font-extrabold font-mono text-rose-300">{accaPerf.lost}</div>
              <div className="text-[10px] text-slate-400">Lost</div>
            </div>
            <div className="bg-black/50 rounded-lg p-3 text-center">
              <div className={`text-xl font-extrabold font-mono ${accaPerf.winRate >= 50 ? "text-emerald-300" : "text-rose-300"}`}>
                {accaPerf.winRate.toFixed(0)}%
              </div>
              <div className="text-[10px] text-slate-400">Win Rate</div>
            </div>
            <div className="bg-black/50 rounded-lg p-3 text-center">
              <div className={`text-xl font-extrabold font-mono ${accaPerf.roi >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                {accaPerf.roi >= 0 ? "+" : ""}{accaPerf.roi.toFixed(1)}%
              </div>
              <div className="text-[10px] text-slate-400">ROI</div>
            </div>
          </div>
          <div className="bg-black/50 rounded-lg divide-y divide-white/5">
            {accaPerf.slips.map(s => (
              <div key={s.id} className="flex items-center justify-between px-4 py-2 text-xs">
                <div>
                  <span className="text-white font-medium">{s.name}</span>
                  <span className="text-slate-400 ml-2">{s.legs} legs | odds {s.odds?.toFixed(2)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-slate-400 font-mono">${(s.stake ?? 10).toFixed(0)} → ${s.potentialReturn?.toFixed(2)}</span>
                  <span className={`rounded px-2 py-0.5 text-[10px] font-bold font-mono ${
                    s.status === "won" ? "bg-emerald-500/20 text-emerald-300" : s.status === "lost" ? "bg-rose-500/20 text-rose-300" : "bg-amber-500/20 text-amber-300"
                  }`}>{s.status.toUpperCase()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 inline-block bg-black/60 rounded-lg px-3 py-1.5">
          <h3 className="text-sm font-bold text-white">Match-by-Match History</h3>
        </div>
        <div className="space-y-3">
          {data.recentMatches.map((m) => {
            const perfect = m.misses === 0 && m.hits > 0;
            return (
              <div key={m.id} className="bg-black/50 rounded-lg p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div>
                    <span className="text-sm font-bold text-white">{m.matchLabel}</span>
                    <span className="ml-2 text-xs text-slate-400 font-mono">{m.homeScore}-{m.awayScore}</span>
                    <span className="ml-2 text-xs text-slate-500">{m.league} | {m.matchDate}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {m.pending > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="rounded px-2 py-1 text-[10px] font-mono bg-amber-500/20 text-amber-300 border border-amber-500/30">
                          {m.pending} to resolve
                        </span>
                        <button
                          onClick={async () => {
                            setResolvingId(m.id);
                            try {
                              await fetch("/api/verify-pending", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ performanceId: m.id }),
                              });
                              await refreshPerformance();
                            } catch {
                              // keep the button usable if the request fails
                            } finally {
                              setResolvingId(null);
                            }
                          }}
                          disabled={resolvingId === m.id}
                          className="rounded px-2 py-1 text-[10px] font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/40"
                        >
                          {resolvingId === m.id ? "Searching..." : "Web Search"}
                        </button>
                      </div>
                    )}
                    <div className={`rounded px-2 py-1 text-xs font-bold font-mono ${
                      perfect ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" :
                      m.misses > 0 ? "bg-rose-500/20 text-rose-300 border border-rose-500/30" :
                      "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                    }`}>
                      {m.hits}H {m.misses}M / {m.totalPicks}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-1">
                  {m.top10Detail.map((pick, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs bg-black/20 rounded px-2 py-1.5">
                      <span className={`w-12 shrink-0 text-right font-mono font-bold ${
                        pick.outcome === "HIT" ? "text-emerald-400" : pick.outcome === "MISS" ? "text-rose-400" : "text-amber-400"
                      }`}>
                        {pick.outcome}
                      </span>
                      <span className="text-slate-200 truncate flex-1">{pick.name}</span>
                      <span className="text-slate-400 shrink-0">{pick.selection}</span>
                      {pick.outcome === "PENDING" && (
                        <span className="flex gap-1 shrink-0 ml-1">
                          <button
                            onClick={async () => {
                              try {
                                await fetch("/api/performance/resolve", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ performanceId: m.id, pickIndex: i, outcome: "HIT" }),
                                });
                                await refreshPerformance();
                              } catch { /* ignore network failures */ }
                            }}
                            className="rounded bg-emerald-500/30 border border-emerald-500/50 px-2 py-0.5 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/50"
                          >
                            HIT
                          </button>
                          <button
                            onClick={async () => {
                              try {
                                await fetch("/api/performance/resolve", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ performanceId: m.id, pickIndex: i, outcome: "MISS" }),
                                });
                                await refreshPerformance();
                              } catch { /* ignore network failures */ }
                            }}
                            className="rounded bg-rose-500/30 border border-rose-500/50 px-2 py-0.5 text-[10px] font-bold text-rose-300 hover:bg-rose-500/50"
                          >
                            MISS
                          </button>
                        </span>
                      )}
                    </div>
                  ))}
                </div>
               </div>
            );
          })}
        </div>
      </div>

      {/* Accuracy Trend Panel */}
      {activeSubTab === "accuracy" && accuracy && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "30-Day Accuracy", val: accuracy.cumulative?.accuracyPct ?? "—", color: (accuracy.cumulative?.accuracy ?? 0) >= 0.90 ? "text-emerald-300" : "text-amber-300" },
              { label: "Last 7 Days",     val: accuracy.rolling7d?.accuracyPct ?? "—", color: "text-cyan-300" },
              { label: "Matches Logged",  val: String(accuracy.cumulative?.matches ?? 0), color: "text-white" },
              { label: "Trend",           val: accuracy.cumulative?.trend ?? "—", color: (accuracy.cumulative?.trend ?? "").includes("↑") ? "text-emerald-300" : "text-amber-300" },
            ].map((c) => (
              <div key={c.label} className="bg-black/50 rounded-lg p-3 text-center border border-white/5">
                <div className={`text-xl font-extrabold font-mono ${c.color}`}>{c.val}</div>
                <div className="text-[10px] text-slate-400 mt-0.5">{c.label}</div>
              </div>
            ))}
          </div>
          {accuracy.daily && accuracy.daily.length > 0 && (
            <div className="bg-black/50 rounded-lg p-4">
              <div className="text-xs font-bold text-white font-mono mb-3">DAILY ACCURACY — last {accuracy.daily.length} days</div>
              <div className="flex items-end gap-0.5 h-24">
                {accuracy.daily.slice(-30).map((day, i) => {
                  const pct = day.accuracy;
                  const h   = Math.max(4, Math.round(pct * 96));
                  const col = pct >= 0.90 ? "bg-emerald-500" : pct >= 0.75 ? "bg-amber-500" : pct >= 0.60 ? "bg-orange-500" : "bg-rose-500";
                  return (
                    <div key={i} className="flex-1 flex items-end" title={`${day.date}: ${(pct*100).toFixed(0)}% (${day.matches} matches)`}>
                      <div className={`w-full rounded-t ${col} opacity-75 hover:opacity-100 transition`} style={{ height: `${h}px` }} />
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between text-[9px] text-slate-500 font-mono mt-1">
                <span>{accuracy.daily[Math.max(0,accuracy.daily.length-30)]?.date}</span>
                <span>{accuracy.daily[accuracy.daily.length-1]?.date}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Calibration Panel */}
      {activeSubTab === "calibration" && calibData && (
        <div className="bg-black/50 rounded-lg p-4">
          <div className="text-xs font-bold text-white font-mono mb-2">SELF-TUNING CALIBRATION</div>
          <p className="text-[11px] text-slate-400 mb-3">Empirical hit rates vs current model reliability coefficients. Updates automatically from performance log.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead className="text-[10px] uppercase text-slate-400 border-b border-white/10">
                <tr>
                  <th className="text-left py-2 px-2">Family</th>
                  <th className="text-center py-2">Picks</th>
                  <th className="text-center py-2">Observed</th>
                  <th className="text-center py-2">Model</th>
                  <th className="text-center py-2">Suggested</th>
                  <th className="text-center py-2">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {(calibData.families ?? []).map((f) => (
                  <tr key={f.family} className="hover:bg-white/[0.02]">
                    <td className="py-2 px-2 text-slate-200 font-medium">{f.family}</td>
                    <td className="py-2 text-center text-slate-400">{f.total}</td>
                    <td className="py-2 text-center font-bold text-white">{f.observedPct}</td>
                    <td className="py-2 text-center text-slate-400">{f.currentCoeff.toFixed(2)}</td>
                    <td className="py-2 text-center text-amber-300">{f.suggestedCoeff.toFixed(2)}</td>
                    <td className="py-2 text-center">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${f.action.includes("INCREASE") ? "bg-emerald-500/20 text-emerald-300" : f.action.includes("DECREASE") ? "bg-rose-500/20 text-rose-300" : "bg-slate-700/50 text-slate-400"}`}>
                        {f.action}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="bg-black/50 rounded-lg p-4 text-center">
      <div className={`text-2xl font-extrabold font-mono ${color}`}>{value}</div>
      <div className="text-xs text-white font-medium mt-1">{label}</div>
      <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>
    </div>
  );
}

// --------------- ACCUMULATOR PAGE ---------------
interface AccaPick {
  matchLabel: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  homeLogo: string | null;
  awayLogo: string | null;
  marketName: string;
  selection: string;
  hitRate: number;
  fairOdds: number;
  reason: string;
  family: string;
  date: string;
  fixtureId?: string;
  leagueSlug?: string;
  valueEdge?: number;
  bookOdds?: number;
  outcome?: "HIT" | "MISS" | "PENDING";
}

interface Acca {
  name: string;
  picks: AccaPick[];
  combinedProbability: number;
  combinedOdds: number;
  legs: number;
  risk: "LOW" | "MEDIUM" | "HIGH";
  type?: "highhit" | "value";
}

interface SavedSlip {
  id: number;
  name: string;
  slipType: string;
  picks: AccaPick[];
  combinedOdds: number;
  combinedProb: number;
  stake: number;
  status: string;
  createdAt: string;
}

type AccaStats = {
  total: number; won: number; lost: number; pending: number; settled: number;
  winRate: number; roi: number; totalStaked: number; totalReturns: number;
  slips: Array<{ id: number; name: string; type: string; legs: number; odds: number; prob: number; stake: number | null; status: string; potentialReturn: number }>;
};

function AccumulatorPage() {
  const [accas, setAccas]               = useState<Acca[]>([]);
  const [loading, setLoading]           = useState(true);
  const [totalAnalysed, setTotalAnalysed] = useState(0);
  const [accaTab, setAccaTab]           = useState<"highhit" | "value" | "slips" | "performance">("highhit");
  const [savedSlips, setSavedSlips]     = useState<SavedSlip[]>([]);
  const [verifying, setVerifying]       = useState(false);
  const [verifyMsg, setVerifyMsg]       = useState<string | null>(null);
  const [perfData, setPerfData]         = useState<{ all: AccaStats; highHit: AccaStats; value: AccaStats } | null>(null);

  const loadAll = useCallback(() => {
    fetch("/api/accumulator").then(r => r.json()).then((d: { accumulators: Acca[]; totalMatchesAnalysed: number }) => {
      setAccas(d.accumulators ?? []); setTotalAnalysed(d.totalMatchesAnalysed ?? 0);
    }).catch(() => {}).finally(() => setLoading(false));
    fetch("/api/slips").then(r => r.json()).then((d: { slips: SavedSlip[] }) => setSavedSlips(d.slips ?? [])).catch(() => {});
    fetch("/api/performance").then(r => r.json()).then((d: { accumulatorPerformance?: { all: AccaStats; highHit: AccaStats; value: AccaStats } }) => {
      setPerfData(d.accumulatorPerformance ?? null);
    }).catch(() => {});
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Auto-verify on mount + every 5 minutes while tab is open
  useEffect(() => {
    const autoVerify = () => {
      fetch("/api/accumulator/verify", { method: "POST" })
        .then(r => r.json())
        .then((d: { settled?: number }) => { if ((d.settled ?? 0) > 0) loadAll(); })
        .catch(() => {});
    };
    autoVerify();
    const t = setInterval(autoVerify, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [loadAll]);

  async function manualVerify() {
    setVerifying(true); setVerifyMsg(null);
    try {
      const r = await fetch("/api/accumulator/verify", { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as { settled?: number; won?: number; lost?: number; stillPending?: number };
      setVerifyMsg(`✓ ${d.settled ?? 0} settled (${d.won ?? 0} won, ${d.lost ?? 0} lost) · ${d.stillPending ?? 0} still pending`);
      loadAll();
    } catch {
      setVerifyMsg("Verification failed — please try again.");
    } finally {
      setVerifying(false);
    }
  }

  async function deleteSlip(id: number) {
    try {
      await fetch("/api/slips", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status: "void" }) });
    } catch { /* ignore network failures */ }
    loadAll();
  }

  async function updateStake(slipId: number, stake: number) {
    // Update stake via slips endpoint
    try {
      await fetch("/api/slips", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: slipId, stake }) });
    } catch { /* ignore network failures */ }
    loadAll();
  }

  const valueAccas    = accas.filter(a => a.picks.some(p => (p.valueEdge ?? 0) > 0));
  const pendingSlips  = savedSlips.filter(s => s.status === "pending");
  const wonSlips      = savedSlips.filter(s => s.status === "won");
  const lostSlips     = savedSlips.filter(s => s.status === "lost");
  const totalStaked   = savedSlips.filter(s => s.status !== "pending").reduce((s, r) => s + (r.stake ?? 10), 0);
  const totalReturns  = wonSlips.reduce((s, r) => s + (r.stake ?? 10) * (r.combinedOdds ?? 1), 0);
  const overallPnl    = totalReturns - totalStaked;
  const winRate       = (wonSlips.length + lostSlips.length) > 0 ? (wonSlips.length / (wonSlips.length + lostSlips.length)) * 100 : 0;

  if (loading) return <LoadingGrid label="Scanning upcoming matches…" />;

  return (
    <div className="space-y-4">
      {/* Header + stats */}
      <div className="bg-black/50 rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-white">ACCUMULATORS</h2>
            <p className="text-xs text-slate-400 mt-0.5">{totalAnalysed} matches analysed · {savedSlips.length} slips tracked</p>
          </div>
          {savedSlips.length > 0 && (
            <div className="flex gap-3 text-xs font-mono flex-wrap">
              <span className="text-slate-400">Pending: <strong className="text-amber-300">{pendingSlips.length}</strong></span>
              <span className="text-slate-400">Won: <strong className="text-emerald-300">{wonSlips.length}</strong></span>
              <span className="text-slate-400">Lost: <strong className="text-rose-300">{lostSlips.length}</strong></span>
              <span className="text-slate-400">Win Rate: <strong className={winRate >= 50 ? "text-emerald-300" : "text-rose-300"}>{winRate.toFixed(0)}%</strong></span>
              <span className="text-slate-400">P&L: <strong className={overallPnl >= 0 ? "text-emerald-300" : "text-rose-300"}>{overallPnl >= 0 ? "+" : ""}${overallPnl.toFixed(2)}</strong></span>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={() => setAccaTab("highhit")}    className={`rounded-lg px-3 py-2 text-xs font-bold transition ${accaTab === "highhit"     ? "bg-amber-400 text-slate-950"   : "bg-black/50 text-slate-300 hover:bg-black/70"}`}>🔒 High Hit</button>
        <button onClick={() => setAccaTab("value")}      className={`rounded-lg px-3 py-2 text-xs font-bold transition ${accaTab === "value"       ? "bg-emerald-400 text-slate-950" : "bg-black/50 text-slate-300 hover:bg-black/70"}`}>💎 Value Bets</button>
        <button onClick={() => setAccaTab("slips")}      className={`rounded-lg px-3 py-2 text-xs font-bold transition ${accaTab === "slips"       ? "bg-cyan-400 text-slate-950"    : "bg-black/50 text-slate-300 hover:bg-black/70"}`}>
          📋 My Slips {pendingSlips.length > 0 && <span className="ml-1 rounded-full bg-amber-400 text-slate-950 text-[9px] px-1.5 py-0.5 font-black">{pendingSlips.length}</span>}
        </button>
        <button onClick={() => setAccaTab("performance")} className={`rounded-lg px-3 py-2 text-xs font-bold transition ${accaTab === "performance" ? "bg-purple-400 text-slate-950"  : "bg-black/50 text-slate-300 hover:bg-black/70"}`}>📊 Performance</button>

        {/* Auto-verify with manual trigger */}
        <button onClick={manualVerify} disabled={verifying}
          className="ml-auto rounded-lg bg-emerald-500/20 border border-emerald-500/40 px-3 py-1.5 text-xs font-bold text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50 transition">
          {verifying ? "Verifying…" : "⚡ Verify Now"}
        </button>
      </div>

      {verifyMsg && (
        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-4 py-2 text-xs text-emerald-300 font-mono">{verifyMsg}</div>
      )}

      {/* ── HIGH HIT ── */}
      {accaTab === "highhit" && (
        accas.filter(a => a.type !== "value").length === 0 ? (
          <div className="bg-black/50 rounded-lg p-10 text-center text-slate-400 text-sm font-mono">No accumulators available right now. Check back on match day.</div>
        ) : (
          <div className="space-y-4">
            {accas.filter(a => a.type !== "value").map((acca, idx) => (
              <AccaCardRender key={`hh-${idx}`} acca={acca} onSave={loadAll} />
            ))}
          </div>
        )
      )}

      {/* ── VALUE BETS ── */}
      {accaTab === "value" && (
        valueAccas.length === 0 ? (
          <div className="bg-black/50 rounded-lg p-10 text-center text-slate-400 text-sm font-mono">No value bet accumulators found. Check back closer to match kick-off.</div>
        ) : (
          <div className="space-y-4">
            {valueAccas.map((acca, idx) => (
              <AccaCardRender key={`val-${idx}`} acca={acca} onSave={loadAll} />
            ))}
          </div>
        )
      )}

      {/* ── MY SLIPS ── */}
      {accaTab === "slips" && (
        <div className="space-y-3">
          {savedSlips.length === 0 ? (
            <div className="bg-black/50 rounded-lg p-10 text-center">
              <div className="text-2xl mb-3">📋</div>
              <div className="text-sm font-bold text-slate-300 mb-2">No slips tracked yet</div>
              <p className="text-xs text-slate-400 font-mono">Click &quot;Track Slip&quot; on any accumulator to start tracking.</p>
            </div>
          ) : (
            savedSlips.map((slip) => (
              <SavedSlipCard key={slip.id} slip={slip} onVerify={manualVerify} onDelete={deleteSlip} onUpdateStake={updateStake} />
            ))
          )}
        </div>
      )}

      {/* ── PERFORMANCE ── */}
      {accaTab === "performance" && (
        <div className="space-y-6">
          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              { label: "Total Slips",  val: String(savedSlips.length),          color: "text-white" },
              { label: "Won",          val: String(wonSlips.length),            color: "text-emerald-300" },
              { label: "Lost",         val: String(lostSlips.length),           color: "text-rose-300" },
              { label: "Win Rate",     val: `${winRate.toFixed(0)}%`,           color: winRate >= 50 ? "text-emerald-300" : "text-rose-300" },
              { label: "P&L",          val: `${overallPnl >= 0 ? "+" : ""}$${overallPnl.toFixed(2)}`, color: overallPnl >= 0 ? "text-emerald-300" : "text-rose-300" },
            ].map((c) => (
              <div key={c.label} className="bg-black/50 rounded-lg p-3 text-center border border-white/5">
                <div className={`text-xl font-extrabold font-mono ${c.color}`}>{c.val}</div>
                <div className="text-[10px] text-slate-400 mt-0.5">{c.label}</div>
              </div>
            ))}
          </div>
          {/* From /api/performance accumulatorPerformance */}
          {perfData ? (
            <div className="space-y-4">
              <div>
                <div className="mb-2 text-xs font-bold text-amber-300 font-mono">HIGH HIT ACCAS</div>
                <AccaPerfBlock data={perfData.highHit} />
              </div>
              <div>
                <div className="mb-2 text-xs font-bold text-emerald-300 font-mono">VALUE BET ACCAS</div>
                <AccaPerfBlock data={perfData.value} />
              </div>
              <div>
                <div className="mb-2 text-xs font-bold text-white font-mono">ALL COMBINED</div>
                <AccaPerfBlock data={perfData.all} />
              </div>
            </div>
          ) : (
            <div className="bg-black/50 rounded-lg p-6 text-center text-slate-400 text-sm font-mono">
              Performance data builds automatically as slips are verified after matches.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Saved Slip Card with full interaction
function SavedSlipCard({
  slip, onVerify, onDelete, onUpdateStake,
}: { slip: SavedSlip; onVerify: () => void; onDelete: (id: number) => void; onUpdateStake: (id: number, stake: number) => void }) {
  const [editingStake, setEditingStake] = useState(false);
  const [stakeVal, setStakeVal]         = useState(String(slip.stake ?? 10));
  const [expanded, setExpanded]         = useState(false);

  const picks = (slip.picks ?? []) as AccaPick[];
  const hits    = picks.filter(p => p.outcome === "HIT").length;
  const misses  = picks.filter(p => p.outcome === "MISS").length;
  const pending = picks.filter(p => !p.outcome || p.outcome === "PENDING").length;
  const allSettled = pending === 0 && picks.length > 0;

  const statusColor = slip.status === "won"  ? "border-l-emerald-500 bg-emerald-500/5" :
                      slip.status === "lost" ? "border-l-rose-500 bg-rose-500/5" :
                                               "border-l-amber-500 bg-black/50";

  return (
    <div className={`rounded-lg border border-white/10 border-l-2 ${statusColor} overflow-hidden`}>
      {/* Header */}
      <button onClick={() => setExpanded(e => !e)} className="w-full text-left p-3 hover:bg-white/[0.02] transition">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-bold text-white">{slip.name}</div>
            <div className="text-[10px] text-slate-400 font-mono mt-0.5">
              {picks.length} legs · odds {slip.combinedOdds?.toFixed(2)} · {new Date(slip.createdAt).toLocaleDateString()}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Per-leg outcome indicators */}
            <div className="flex gap-0.5">
              {picks.map((p, i) => (
                <span key={i} className={`inline-block w-3 h-3 rounded-sm text-[8px] flex items-center justify-center font-bold ${
                  p.outcome === "HIT"  ? "bg-emerald-500 text-white" :
                  p.outcome === "MISS" ? "bg-rose-500 text-white" :
                                         "bg-slate-600 text-slate-400"
                }`}>
                  {p.outcome === "HIT" ? "✓" : p.outcome === "MISS" ? "✗" : "·"}
                </span>
              ))}
            </div>
            {/* Status badge */}
            <span className={`rounded px-2 py-0.5 text-[10px] font-bold font-mono ${
              slip.status === "won"     ? "bg-emerald-500/20 text-emerald-300" :
              slip.status === "lost"   ? "bg-rose-500/20 text-rose-300" :
              allSettled               ? "bg-amber-500/20 text-amber-300" :
                                         "bg-slate-700/50 text-slate-400"
            }`}>
              {slip.status === "won" ? "WON ✓" : slip.status === "lost" ? "LOST ✗" : allSettled ? "SETTLED" : `${pending} PENDING`}
            </span>
            {/* P&L */}
            {slip.status === "won" && (
              <span className="text-xs font-mono text-emerald-300 font-bold">
                +${((slip.stake ?? 10) * slip.combinedOdds - (slip.stake ?? 10)).toFixed(2)}
              </span>
            )}
            {slip.status === "lost" && (
              <span className="text-xs font-mono text-rose-300 font-bold">-${(slip.stake ?? 10).toFixed(2)}</span>
            )}
          </div>
        </div>

        {/* Stake editor inline */}
        <div className="mt-2 flex items-center gap-2" onClick={e => e.stopPropagation()}>
          <span className="text-[10px] text-slate-500 font-mono">Stake:</span>
          {editingStake ? (
            <div className="flex gap-1 items-center">
              <input value={stakeVal} onChange={e => setStakeVal(e.target.value)} type="number" min="1"
                className="w-16 rounded bg-black/50 border border-white/20 px-2 py-0.5 text-xs text-white outline-none font-mono" />
              <button onClick={() => { onUpdateStake(slip.id, parseFloat(stakeVal) || 10); setEditingStake(false); }}
                className="rounded bg-amber-400 text-slate-950 px-2 py-0.5 text-[10px] font-bold">Save</button>
              <button onClick={() => setEditingStake(false)} className="text-[10px] text-slate-400 hover:text-white">✕</button>
            </div>
          ) : (
            <button onClick={() => setEditingStake(true)} className="text-[10px] text-amber-300 font-mono hover:text-amber-200">
              ${slip.stake ?? 10} → ${((slip.stake ?? 10) * slip.combinedOdds).toFixed(2)} · <span className="underline">edit</span>
            </button>
          )}
        </div>
      </button>

      {/* Expanded legs */}
      {expanded && (
        <div className="border-t border-white/5">
          {picks.map((pick, i) => (
            <div key={i} className={`flex items-center gap-2 px-3 py-2 text-xs border-b border-white/5 ${
              pick.outcome === "HIT"  ? "bg-emerald-500/5" :
              pick.outcome === "MISS" ? "bg-rose-500/5" : ""
            }`}>
              <span className={`w-4 h-4 rounded flex items-center justify-center shrink-0 font-bold text-[10px] ${
                pick.outcome === "HIT"  ? "bg-emerald-500 text-white" :
                pick.outcome === "MISS" ? "bg-rose-500 text-white" :
                                           "bg-slate-600/50 text-slate-400"
              }`}>{pick.outcome === "HIT" ? "✓" : pick.outcome === "MISS" ? "✗" : i+1}</span>
              <div className="flex-1 min-w-0">
                <div className="text-slate-200 font-medium truncate">{pick.matchLabel}</div>
                <div className="text-[10px] text-slate-400 font-mono truncate">{pick.marketName} · {pick.selection}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-emerald-300 font-mono font-bold text-[11px]">{(pick.hitRate * 100).toFixed(0)}%</div>
                <div className="text-slate-500 font-mono text-[9px]">{pick.date}</div>
              </div>
            </div>
          ))}
          <div className="flex gap-2 px-3 py-2 bg-black/20">
            <button onClick={onVerify} className="rounded bg-emerald-500/20 border border-emerald-500/40 px-3 py-1 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/30">⚡ Re-verify</button>
            <button onClick={() => onDelete(slip.id)} className="rounded bg-rose-500/20 border border-rose-500/40 px-3 py-1 text-[10px] font-bold text-rose-300 hover:bg-rose-500/30">🗑 Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}

function AccaCardRender({ acca, onSave }: { acca: Acca; onSave?: () => void }) {
  const [stake, setStake]     = useState(10);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);

  async function trackSlip() {
    setSaving(true);
    try {
      const r = await fetch("/api/slips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: acca.name,
          slipType: acca.type ?? "highhit",
          picks: acca.picks,
          combinedOdds: acca.combinedOdds,
          combinedProb: acca.combinedProbability,
          stake,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSaved(true);
      onSave?.();
    } catch {
      // leave the button usable so the user can retry
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-black/50 rounded-lg overflow-hidden border border-white/5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-white/10">
        <div>
          <h3 className="text-sm font-bold text-white">{acca.name}</h3>
          <span className="text-xs text-slate-400 font-mono">{acca.legs} legs</span>
        </div>
        <div className="flex items-center gap-3">
          <div className={`rounded px-2 py-1 text-xs font-bold font-mono border ${
            acca.risk === "LOW"    ? "bg-emerald-500/20 border-emerald-500/30 text-emerald-300" :
            acca.risk === "MEDIUM" ? "bg-amber-500/20 border-amber-500/30 text-amber-300" :
                                     "bg-rose-500/20 border-rose-500/30 text-rose-300"
          }`}>{acca.risk} RISK</div>
          <div className="text-right">
            <div className="text-lg font-extrabold font-mono text-amber-300">{acca.combinedOdds.toFixed(2)}</div>
            <div className="text-[10px] text-slate-400">odds</div>
          </div>
          <div className="text-right">
            <div className="text-lg font-extrabold font-mono text-emerald-300">{(acca.combinedProbability * 100).toFixed(1)}%</div>
            <div className="text-[10px] text-slate-400">prob</div>
          </div>
        </div>
      </div>

      {/* Picks */}
      <div className="divide-y divide-white/5">
        {acca.picks.map((pick, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-2.5">
            <span className="text-xs font-mono text-slate-500 w-5 shrink-0">{i + 1}.</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-white font-medium truncate">{pick.matchLabel}</div>
              <div className="text-[10px] text-slate-400 font-mono">{pick.league} · {pick.date}</div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[10px] font-mono text-amber-300 font-bold">{pick.marketName}</div>
              <span className="rounded bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-mono font-bold text-emerald-300">{pick.selection}</span>
            </div>
            <div className="text-right shrink-0 w-14">
              <div className="text-sm font-bold font-mono text-emerald-300">{(pick.hitRate * 100).toFixed(0)}%</div>
              {(pick.valueEdge ?? 0) > 0 && (
                <div className="text-[9px] text-cyan-300 font-mono">+{((pick.valueEdge ?? 0) * 100).toFixed(1)}%</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Stake + Track footer */}
      <div className="p-3 bg-black/30 border-t border-white/5">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 font-mono">Stake:</span>
            <input
              type="number" min="1" value={stake}
              onChange={e => setStake(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-16 rounded bg-black/50 border border-white/20 px-2 py-1 text-xs text-white outline-none font-mono focus:border-amber-400"
            />
            <span className="text-xs text-slate-400 font-mono">→</span>
            <span className="text-xs font-bold text-amber-300 font-mono">${(stake * acca.combinedOdds).toFixed(2)}</span>
          </div>
          <div className="ml-auto flex gap-2">
            {saved ? (
              <span className="rounded bg-emerald-500/20 border border-emerald-500/40 px-3 py-1.5 text-xs font-bold text-emerald-300 font-mono">✓ Tracked</span>
            ) : (
              <button onClick={trackSlip} disabled={saving}
                className="rounded bg-amber-400 text-slate-950 px-4 py-1.5 text-xs font-bold hover:bg-amber-300 disabled:opacity-50 transition">
                {saving ? "Saving…" : "📋 Track Slip"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// --------------- CHAT ASSISTANT ---------------
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: Array<{ title: string; url: string; snippet: string }>;
}

function ChatAssistant() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function send() {
    const msg = input.trim();
    if (!msg || loading) return;

    const userMsg: ChatMessage = { role: "user", content: msg };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      const data = await res.json() as { answer?: string; sources?: Array<{ title: string; url: string; snippet: string }> };
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: data.answer ?? "No answer found.",
        sources: data.sources,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "Search failed. Please try again." }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-black/50 rounded-lg p-4">
        <h2 className="text-base font-bold text-white">Ask Anything</h2>
        <p className="text-xs text-slate-400 mt-1">Web search assistant — ask about players, transfers, stats, match previews, or anything football related</p>
      </div>

      <div className="space-y-3 min-h-[200px] max-h-[60vh] overflow-y-auto">
        {messages.length === 0 && (
          <div className="bg-black/30 rounded-lg p-6 text-center text-slate-400 text-sm">
            <p className="mb-3">Ask me anything about football. For example:</p>
            <div className="flex flex-wrap justify-center gap-2">
              {["Who is the top scorer in World Cup 2026?", "Arsenal latest transfer news", "Mbappe career stats", "La Liga standings 2026"].map((q) => (
                <button
                  key={q}
                  onClick={() => { setInput(q); }}
                  className="rounded-full bg-black/40 border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10 transition"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-lg p-3 ${
              msg.role === "user"
                ? "bg-amber-400/20 border border-amber-400/30 text-slate-100"
                : "bg-black/50 border border-white/10 text-slate-200"
            }`}>
              <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-2 pt-2 border-t border-white/10 space-y-1">
                  <div className="text-[10px] text-slate-400 font-mono">Sources:</div>
                  {msg.sources.map((s, si) => (
                    <a
                      key={si}
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-xs text-cyan-400 hover:text-cyan-300 truncate"
                    >
                      {s.title}
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-black/50 border border-white/10 rounded-lg p-3 text-sm text-slate-400 animate-pulse font-mono">
              Searching the web...
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          placeholder="Ask anything about football..."
          className="flex-1 rounded-lg border border-white/15 bg-black/50 px-4 py-3 text-sm text-slate-100 outline-none focus:border-amber-400 font-mono"
          disabled={loading}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="rounded-lg bg-amber-400 px-5 py-3 text-sm font-bold text-slate-950 hover:bg-amber-300 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}

// --------------- BANKROLL TRACKER ---------------
function BankrollTracker() {
  const [data, setData] = useState<{
    balance: number; deposits: number; totalStaked: number; totalReturns: number;
    roi: number; profitLoss: number; totalBets: number; wonBets: number;
    entries: Array<{ id: number; type: string; amount: number; balance: number; description: string; createdAt: string }>;
  } | null>(null);
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [type, setType] = useState("deposit");
  const [accountBalance, setAccountBalance] = useState("");
  const [loading, setLoading] = useState(true);

  // Fetch-only: all state updates happen asynchronously in the promise chain
  // (initial `loading` already defaults to true).
  const load = useCallback(() => {
    fetch("/api/bankroll").then(r => r.json()).then((d: typeof data) => setData(d)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingGrid label="Loading bankroll..." />;

  async function submit() {
    if (!amount || !desc) return;
    const num = parseFloat(amount);
    if (isNaN(num)) return;
    const finalAmount = type === "bet" ? -Math.abs(num) : Math.abs(num);
    try {
      await fetch("/api/bankroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, amount: finalAmount, description: desc }),
      });
      setAmount(""); setDesc("");
    } catch { /* keep the form values so the user can retry */ }
    load();
  }

  async function setInitialBalance() {
    const num = parseFloat(accountBalance);
    if (isNaN(num) || num <= 0) return;
    try {
      await fetch("/api/bankroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "deposit", amount: num, description: "My account balance" }),
      });
      setAccountBalance("");
    } catch { /* keep the form value so the user can retry */ }
    load();
  }

  if (data && data.entries.length === 0) {
    return (
      <div className="space-y-6">
        <div className="bg-black/50 rounded-lg p-4">
          <h2 className="text-base font-bold text-white">Bankroll Tracker</h2>
          <p className="text-xs text-slate-400 mt-1">Enter your betting account balance to start tracking</p>
        </div>
        <div className="bg-black/50 rounded-lg p-6">
          <div className="text-sm font-bold text-white mb-2">What is your current betting account balance?</div>
          <p className="text-xs text-slate-400 mb-4">Enter the total amount currently in your betting account.</p>
          <div className="flex gap-2 items-center">
            <span className="text-2xl font-bold text-amber-300 font-mono">$</span>
            <input value={accountBalance} onChange={e => setAccountBalance(e.target.value)}
              placeholder="e.g. 500" type="number" step="0.01"
              className="flex-1 rounded-lg border border-white/15 bg-black/40 px-4 py-3 text-xl text-white outline-none focus:border-amber-400 font-mono" />
            <button onClick={setInitialBalance}
              className="rounded-lg bg-amber-400 px-6 py-3 text-sm font-bold text-slate-950 hover:bg-amber-300">
              Start Tracking
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-black/50 rounded-lg p-4">
        <h2 className="text-base font-bold text-white">Bankroll Tracker</h2>
        <p className="text-xs text-slate-400 mt-1">Track your betting account balance, bets, wins and ROI</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="bg-black/50 rounded-lg p-3 text-center">
          <div className="text-xl font-extrabold font-mono text-amber-300">${(data?.balance ?? 0).toFixed(2)}</div>
          <div className="text-[10px] text-slate-400">Current Balance</div>
        </div>
        <div className="bg-black/50 rounded-lg p-3 text-center">
          <div className={`text-xl font-extrabold font-mono ${(data?.profitLoss ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
            {(data?.profitLoss ?? 0) >= 0 ? "+" : ""}{(data?.profitLoss ?? 0).toFixed(2)}
          </div>
          <div className="text-[10px] text-slate-400">Profit / Loss</div>
        </div>
        <div className="bg-black/50 rounded-lg p-3 text-center">
          <div className={`text-xl font-extrabold font-mono ${(data?.roi ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
            {(data?.roi ?? 0).toFixed(1)}%
          </div>
          <div className="text-[10px] text-slate-400">ROI</div>
        </div>
        <div className="bg-black/50 rounded-lg p-3 text-center">
          <div className="text-xl font-extrabold font-mono text-white">{data?.totalBets ?? 0}</div>
          <div className="text-[10px] text-slate-400">Total Bets</div>
        </div>
      </div>

      <div className="bg-black/50 rounded-lg p-4">
        <div className="text-xs text-slate-400 font-mono mb-2">RECORD TRANSACTION</div>
        <div className="flex flex-wrap gap-2 mb-3">
          {(["deposit", "bet", "win", "withdraw"] as const).map(t => (
            <button key={t} onClick={() => setType(t)}
              className={`rounded px-3 py-1.5 text-xs font-bold capitalize ${type === t ? "bg-amber-400 text-slate-950" : "bg-black/40 text-slate-300 border border-white/15"}`}>
              {t === "deposit" ? "Deposit" : t === "bet" ? "Place Bet" : t === "win" ? "Bet Won" : "Withdraw"}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={amount} onChange={e => setAmount(e.target.value)} placeholder="Amount" type="number"
            className="w-28 rounded border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-amber-400 font-mono" />
          <input value={desc} onChange={e => setDesc(e.target.value)}
            placeholder={type === "bet" ? "e.g. Arsenal Over 2.5 Goals" : "Description"}
            className="flex-1 rounded border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-amber-400" />
          <button onClick={submit} className="rounded bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-amber-300">Add</button>
        </div>
      </div>

      {data?.entries && data.entries.length > 0 && (
        <div>
          <div className="mb-2 inline-block bg-black/60 rounded-lg px-3 py-1.5">
            <h3 className="text-sm font-bold text-white">Transaction History</h3>
          </div>
          <div className="bg-black/50 rounded-lg divide-y divide-white/5">
            {data.entries.map(e => (
              <div key={e.id} className="flex items-center justify-between px-4 py-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-2 py-0.5 text-[10px] font-bold font-mono ${
                    e.type === "win" ? "bg-emerald-500/20 text-emerald-300" :
                    e.type === "bet" ? "bg-rose-500/20 text-rose-300" :
                    e.type === "deposit" ? "bg-amber-500/20 text-amber-300" :
                    "bg-slate-500/20 text-slate-300"
                  }`}>{e.type.toUpperCase()}</span>
                  <span className="text-slate-200">{e.description}</span>
                </div>
                <div className="text-right font-mono flex items-center gap-3">
                  <span className={e.amount >= 0 ? "text-emerald-300" : "text-rose-300"}>
                    {e.amount >= 0 ? "+" : ""}{e.amount.toFixed(2)}
                  </span>
                  <span className="text-slate-500">Balance: ${e.balance.toFixed(2)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --------------- DAILY PICKS ---------------
interface DailyPicksData {
  date: string;
  totalMatches: number;
  picks: Array<{
    match: string; league: string; date: string; homeLogo: string | null; awayLogo: string | null;
    top3: Array<{ name: string; selection: string; hitRate: number; reason: string }>;
    valueBets: Array<{ name: string; selection: string; edge: number; odds: number; kelly: number }>;
  }>;
}

function DailyPicksPage() {
  const [data, setData] = useState<DailyPicksData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/daily-picks").then(r => r.json()).then((d: DailyPicksData) => setData(d)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingGrid label="Generating today's best picks across all leagues..." />;

  return (
    <div className="space-y-6">
      <div className="bg-black/50 rounded-lg p-4">
        <h2 className="text-base font-bold text-white">Daily Picks Report — {data?.date}</h2>
        <p className="text-xs text-slate-400 mt-1">{data?.totalMatches ?? 0} matches analysed across top leagues</p>
      </div>

      {data?.picks?.map((p, idx) => (
        <div key={idx} className="bg-black/50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            {p.homeLogo && <Image src={p.homeLogo} alt="" width={20} height={20} className="object-contain" unoptimized />}
            <span className="text-sm font-bold text-white">{p.match}</span>
            <span className="text-[10px] text-slate-400 font-mono ml-auto">{p.league} | {p.date}</span>
          </div>

          <div className="text-[10px] text-slate-400 font-mono mb-1">TOP 3 PICKS</div>
          <div className="space-y-1 mb-3">
            {p.top3.map((pick, i) => (
              <div key={i} className="flex items-center gap-2 bg-black/30 rounded px-3 py-2 text-xs">
                <span className="font-mono text-slate-500 w-4">{i+1}.</span>
                <span className="text-white flex-1">{pick.name}</span>
                <span className="rounded bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 font-mono font-bold text-emerald-300">{pick.selection}</span>
                <span className="font-mono text-emerald-300">{(pick.hitRate*100).toFixed(0)}%</span>
              </div>
            ))}
          </div>

          {p.valueBets.length > 0 && (
            <div>
              <div className="text-[10px] text-slate-400 font-mono mb-1">VALUE BETS</div>
              {p.valueBets.map((vb, i) => (
                <div key={i} className="flex items-center gap-2 bg-emerald-500/5 border border-emerald-500/15 rounded px-3 py-2 text-xs mb-1">
                  <span className="text-white flex-1">{vb.name} — {vb.selection}</span>
                  <span className="text-emerald-300 font-mono font-bold">+{(vb.edge*100).toFixed(1)}% edge</span>
                  <span className="text-amber-300 font-mono">{vb.odds.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {(!data?.picks || data.picks.length === 0) && (
        <div className="bg-black/50 rounded-lg p-10 text-center text-slate-400 text-sm font-mono">
          No upcoming matches to analyse right now.
        </div>
      )}
    </div>
  );
}

// --------------- ODDS CALCULATOR ---------------
interface OddsResult {
  decimal: number;
  american: number;
  fractional: string;
  impliedProbability: number;
  dutching?: {
    selections: Array<{ odds: number; stake: number; impliedProb: string }>;
    totalStake: number;
    guaranteedReturn: number;
    margin: string;
  };
}

function OddsCalculator() {
  const [input, setInput] = useState("");
  const [format, setFormat] = useState<"decimal"|"american"|"fractional"|"probability">("decimal");
  const [result, setResult] = useState<OddsResult | null>(null);
  const [dutchOdds, setDutchOdds] = useState("");
  const [dutchResult, setDutchResult] = useState<OddsResult["dutching"] | null>(null);

  async function convert() {
    if (!input.trim()) return;
    const params = new URLSearchParams();
    if (format === "decimal") params.set("decimal", input);
    else if (format === "american") params.set("american", input);
    else if (format === "fractional") params.set("fractional", input);
    else params.set("probability", input);
    try {
      const r = await fetch(`/api/odds-calc?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as OddsResult;
      setResult(d);
    } catch {
      setResult(null);
    }
  }

  async function calcDutch() {
    if (!dutchOdds.trim()) return;
    try {
      const r = await fetch(`/api/odds-calc?decimal=1&dutch=${encodeURIComponent(dutchOdds)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as OddsResult;
      setDutchResult(d.dutching ?? null);
    } catch {
      setDutchResult(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-black/50 rounded-lg p-4">
        <h2 className="text-base font-bold text-white">Odds Calculator</h2>
        <p className="text-xs text-slate-400 mt-1">Convert between formats, calculate implied probability, dutching</p>
      </div>

      <div className="bg-black/50 rounded-lg p-4">
        <div className="text-xs text-slate-400 font-mono mb-2">ODDS CONVERTER</div>
        <div className="flex flex-wrap gap-2 mb-3">
          {(["decimal","american","fractional","probability"] as const).map(f => (
            <button key={f} onClick={() => setFormat(f)} className={`rounded px-3 py-1 text-xs font-bold capitalize ${format===f?"bg-amber-400 text-slate-950":"bg-black/40 text-slate-300 border border-white/15"}`}>{f}</button>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={input} onChange={e => setInput(e.target.value)}
            placeholder={format === "decimal" ? "e.g. 2.50" : format === "american" ? "e.g. +150 or -200" : format === "fractional" ? "e.g. 3/2" : "e.g. 0.65"}
            onKeyDown={e => { if(e.key==="Enter") convert(); }}
            className="flex-1 rounded border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-amber-400 font-mono" />
          <button onClick={convert} className="rounded bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950">Convert</button>
        </div>
        {result && (
          <div className="grid grid-cols-2 gap-2 mt-3 sm:grid-cols-4">
            <div className="bg-black/30 rounded p-2 text-center">
              <div className="text-[10px] text-slate-400 font-mono">DECIMAL</div>
              <div className="font-mono font-bold text-amber-300">{result.decimal.toFixed(3)}</div>
            </div>
            <div className="bg-black/30 rounded p-2 text-center">
              <div className="text-[10px] text-slate-400 font-mono">AMERICAN</div>
              <div className="font-mono font-bold text-white">{result.american > 0 ? "+" : ""}{result.american}</div>
            </div>
            <div className="bg-black/30 rounded p-2 text-center">
              <div className="text-[10px] text-slate-400 font-mono">FRACTIONAL</div>
              <div className="font-mono font-bold text-white">{result.fractional}</div>
            </div>
            <div className="bg-black/30 rounded p-2 text-center">
              <div className="text-[10px] text-slate-400 font-mono">PROBABILITY</div>
              <div className="font-mono font-bold text-emerald-300">{result.impliedProbability}%</div>
            </div>
          </div>
        )}
      </div>

      <div className="bg-black/50 rounded-lg p-4">
        <div className="text-xs text-slate-400 font-mono mb-2">DUTCHING CALCULATOR</div>
        <p className="text-[10px] text-slate-400 mb-2">Enter decimal odds separated by commas (e.g. 2.50, 3.20, 4.00)</p>
        <div className="flex gap-2">
          <input value={dutchOdds} onChange={e => setDutchOdds(e.target.value)} placeholder="2.50, 3.20, 4.00"
            className="flex-1 rounded border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-amber-400 font-mono" />
          <button onClick={calcDutch} className="rounded bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950">Calculate</button>
        </div>
        {dutchResult && (
          <div className="mt-3">
            <div className="space-y-1 mb-2">
              {dutchResult.selections.map((s, i) => (
                <div key={i} className="flex items-center justify-between bg-black/30 rounded px-3 py-1.5 text-xs font-mono">
                  <span className="text-white">Selection {i+1}: <span className="text-amber-300">{s.odds.toFixed(2)}</span></span>
                  <span className="text-slate-300">Stake: <span className="text-emerald-300">${s.stake.toFixed(2)}</span></span>
                  <span className="text-slate-400">{s.impliedProb}</span>
                </div>
              ))}
            </div>
            <div className="flex justify-between text-xs font-mono bg-emerald-500/10 border border-emerald-500/20 rounded px-3 py-2">
              <span className="text-slate-300">Total stake: ${dutchResult.totalStake}</span>
              <span className="text-emerald-300 font-bold">Guaranteed return: ${dutchResult.guaranteedReturn.toFixed(2)}</span>
              <span className="text-slate-400">Margin: {dutchResult.margin}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --------------- ACCA PERF BLOCK ---------------
function AccaPerfBlock({ data }: { data: AccaStats }) {
  if (data.total === 0) return (
    <div className="bg-black/50 rounded-lg p-6 text-center text-slate-400 text-sm font-mono">
      No records yet — slips appear here automatically after verification.
    </div>
  );
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[
          { val: String(data.total),                                              label: "Total",    color: "text-amber-300" },
          { val: String(data.won),                                                label: "Won",      color: "text-emerald-300" },
          { val: String(data.lost),                                               label: "Lost",     color: "text-rose-300" },
          { val: `${data.winRate.toFixed(0)}%`,                                   label: "Win Rate", color: data.winRate >= 50 ? "text-emerald-300" : "text-rose-300" },
          { val: `${data.roi >= 0 ? "+" : ""}${data.roi.toFixed(1)}%`,           label: "ROI",      color: data.roi >= 0 ? "text-emerald-300" : "text-rose-300" },
        ].map((c) => (
          <div key={c.label} className="bg-black/50 rounded-lg p-2.5 text-center">
            <div className={`text-lg font-extrabold font-mono ${c.color}`}>{c.val}</div>
            <div className="text-[9px] text-slate-400">{c.label}</div>
          </div>
        ))}
      </div>
      {data.slips.length > 0 && (
        <div className="bg-black/50 rounded-lg divide-y divide-white/5">
          {data.slips.map(s => (
            <div key={s.id} className="flex items-center justify-between px-3 py-2 text-xs">
              <div>
                <span className="text-white font-medium truncate max-w-[200px] inline-block">{s.name}</span>
                <span className="text-slate-400 ml-2 font-mono">{s.legs ? `${s.legs} legs` : ""}{s.odds ? ` · ${s.odds.toFixed(2)}` : ""}</span>
              </div>
              <span className={`rounded px-2 py-0.5 text-[10px] font-bold font-mono ${
                s.status === "won"     ? "bg-emerald-500/20 text-emerald-300" :
                s.status === "lost"   ? "bg-rose-500/20 text-rose-300" :
                                         "bg-amber-500/20 text-amber-300"
              }`}>{s.status.toUpperCase()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --------------- VALUE BET ALERTS (Homepage) ---------------
function ValueAlerts() {
  const [alerts, setAlerts] = useState<Array<{
    match: string; league: string; market: string; selection: string;
    edge: number; odds: number; kelly: number;
    homeLogo: string | null;
  }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/daily-picks")
      .then(r => r.json())
      .then((d: DailyPicksData) => {
        const values: typeof alerts = [];
        for (const pick of d.picks ?? []) {
          for (const vb of pick.valueBets ?? []) {
            if (vb.edge > 0.02) {
              values.push({
                match: pick.match, league: pick.league,
                market: vb.name, selection: vb.selection,
                edge: vb.edge, odds: vb.odds, kelly: vb.kelly,
                homeLogo: pick.homeLogo,
              });
            }
          }
        }
        setAlerts(values.sort((a, b) => b.edge - a.edge).slice(0, 5));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading || alerts.length === 0) return null;

  return (
    <div className="bg-black/50 rounded-lg p-4">
      <div className="text-xs font-bold text-emerald-300 font-mono mb-3">VALUE BET ALERTS — Oracle Edge Over Bookmaker</div>
      <div className="space-y-2">
        {alerts.map((a, i) => (
          <div key={i} className="flex items-center gap-3 bg-emerald-500/5 border border-emerald-500/20 rounded-lg px-3 py-2">
            {a.homeLogo && <Image src={a.homeLogo} alt="" width={18} height={18} className="object-contain" unoptimized />}
            <div className="flex-1 min-w-0">
              <div className="text-sm text-white font-medium truncate">{a.match}</div>
              <div className="text-[10px] text-slate-400">{a.league} | {a.market} — {a.selection}</div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-sm font-extrabold font-mono text-emerald-300">+{(a.edge * 100).toFixed(1)}%</div>
              <div className="text-[10px] text-slate-400 font-mono">{a.odds.toFixed(2)} odds</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
