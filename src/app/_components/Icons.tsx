"use client";

export function IconLive({ size = 12 }: { size?: number }) {
  return (
    <span className="relative inline-flex" style={{ width: size, height: size }}>
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
      <span className="relative inline-flex rounded-full bg-rose-500" style={{ width: size, height: size }} />
    </span>
  );
}

export function IconGoal({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-400">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="3" />
      <line x1="12" y1="2" x2="12" y2="9" />
      <line x1="12" y1="15" x2="12" y2="22" />
      <line x1="2" y1="12" x2="9" y2="12" />
      <line x1="15" y1="12" x2="22" y2="12" />
    </svg>
  );
}

export function IconCard({ color }: { color: "yellow" | "red" }) {
  return (
    <span
      className={`inline-block w-3 h-4 rounded-[2px] ${color === "yellow" ? "bg-amber-400" : "bg-rose-500"}`}
    />
  );
}

export function IconSub({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-cyan-400">
      <polyline points="7,3 7,11 3,7" />
      <polyline points="17,21 17,13 21,17" />
    </svg>
  );
}

export function IconCheck({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="text-emerald-400">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <path d="M8 12l3 3 5-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconCross({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="text-rose-400">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <line x1="8" y1="8" x2="16" y2="16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="16" y1="8" x2="8" y2="16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconClock({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-400">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12,6 12,12 16,14" />
    </svg>
  );
}

export function IconPenalty({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-300">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </svg>
  );
}

export function IconShield({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-cyan-400">
      <path d="M12 2l8 4v6c0 5.5-3.8 10-8 12-4.2-2-8-6.5-8-12V6l8-4z" />
    </svg>
  );
}

export function IconTrophy({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400">
      <path d="M6 9H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
      <path d="M18 9h3a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-3" />
      <path d="M6 4h12v6a6 6 0 0 1-12 0V4z" />
      <path d="M10 16h4v4H10z" />
      <path d="M8 20h8" />
    </svg>
  );
}

export function IconChart({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-300">
      <rect x="3" y="12" width="4" height="9" rx="1" />
      <rect x="10" y="6" width="4" height="15" rx="1" />
      <rect x="17" y="3" width="4" height="18" rx="1" />
    </svg>
  );
}

export function IconTarget({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-400">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

export function IconFire({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="text-amber-400">
      <path d="M12 2c1 4-2 6-2 10a4 4 0 0 0 8 0c0-4-3-6-3-10 0 0-1 4-3 4s-3-4-3-4z" fill="currentColor" opacity="0.8" />
      <path d="M12 2c1 4-2 6-2 10a4 4 0 0 0 8 0c0-4-3-6-3-10" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function IconBolt({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className="text-amber-300">
      <polygon points="13,2 3,14 12,14 11,22 21,10 12,10" />
    </svg>
  );
}

/** Renders the right icon for a match event type */
export function EventIcon({ type }: { type: string }) {
  if (type === "goal" || type === "penalty-goal") return <IconGoal size={16} />;
  if (type === "yellow-card") return <IconCard color="yellow" />;
  if (type === "red-card") return <IconCard color="red" />;
  if (type.includes("sub")) return <IconSub />;
  if (type === "own-goal") return <><IconGoal size={16} /><span className="text-[8px] text-rose-400 font-bold ml-0.5">OG</span></>;
  if (type.includes("penalty")) return <IconPenalty />;
  return <IconClock />;
}

export function OutcomeBadge({ outcome }: { outcome?: string }) {
  if (outcome === "HIT") return (
    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 border border-emerald-500/40 px-2 py-0.5 text-xs font-bold text-emerald-300">
      <IconCheck size={12} /> HIT
    </span>
  );
  if (outcome === "MISS") return (
    <span className="inline-flex items-center gap-1 rounded bg-rose-500/20 border border-rose-500/40 px-2 py-0.5 text-xs font-bold text-rose-300">
      <IconCross size={12} /> MISS
    </span>
  );
  if (outcome === "PENDING") return (
    <span className="inline-flex items-center gap-1 rounded bg-slate-500/20 border border-slate-500/40 px-2 py-0.5 text-xs font-bold text-slate-400">
      <IconClock size={12} /> NO SOURCE
    </span>
  );
  return null;
}
