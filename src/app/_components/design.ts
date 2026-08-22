// ─────────────────────────────────────────────────────────────────────────────
// ĞIGI GIVØ — Interactive Design System
//
// One central source of truth for every clickable element in the app.
// Refined Sports Analytics palette:
//   · Active tabs & primary CTAs: Amber/Gold (#F59E0B → #FF8C00)
//   · Secondary CTAs: Cyan (#06B6D4)
//   · Backgrounds: Deep slate (#0F1117, #1E293B)
//   · Text: White for active states, Slate-400 for inactive states
//   · Fixture cards: translucent glass deck (backdrop-blur) so the background
//     slideshow shows through — see TYPE 10 · GLASS FIXTURE CARDS
//
// Global interaction rules baked into every token:
//   · cursor-pointer + select-none
//   · smooth transitions (transition-all duration-200)
//   · visible keyboard focus rings (accessibility)
//
// Visual layer only — no behaviour or routing lives here.
// ─────────────────────────────────────────────────────────────────────────────

/** Shared interaction baseline required by every clickable element. */
const IX = "cursor-pointer select-none transition-all duration-200";
const GOLD_GRADIENT = "bg-gradient-to-r from-[#F59E0B] to-[#FF8C00]";

/* ═══ TYPE 1 · PRIMARY NAVIGATION — solid slate pills ══════════════════════ */

export const NAV_PILL =
  `${IX} inline-flex items-center gap-1.5 whitespace-nowrap rounded-full ` +
  "hover:scale-105 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70";

/** Inactive pill: solid slate, muted text, slight elevation. */
export const NAV_PILL_OFF =
  "border border-slate-700 bg-slate-800 text-slate-400 shadow-sm hover:bg-slate-700 hover:text-white";

/** Active pill (main app): amber/gold gradient with a coloured glow. */
export const NAV_PILL_ON_AMBER =
  `scale-105 ${GOLD_GRADIENT} font-bold text-white shadow-lg shadow-amber-500/40`;

/** Active pill (performance section): same refined amber/gold active-tab palette. */
export const NAV_PILL_ON_VIOLET = NAV_PILL_ON_AMBER;

/* ═══ TYPE 2 · PRIMARY ACTION BUTTONS — gold/amber CTAs ═══════════════════ */

const ACTION =
  `${IX} rounded-xl font-bold shadow-2xl hover:scale-105 hover:shadow-2xl active:scale-95 ` +
  "hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[#0F1117] " +
  "disabled:pointer-events-none disabled:opacity-50";

const ACTION_GOLD =
  `${ACTION} ${GOLD_GRADIENT} text-white shadow-amber-500/30 focus:ring-amber-300`;

/** Success actions: Verify, Save, Run Backtest, Re-verify, Track confirmation. */
export const ACTION_EMERALD = ACTION_GOLD;

/** Brand actions: Send, Convert, Add, Start Tracking, Track Slip, Set PIN. */
export const ACTION_AMBER = ACTION_GOLD;

/** Info actions: Retry, Try Again, Resolve Pending (Web Search). */
export const ACTION_BLUE = ACTION_GOLD;

/** Destructive primary actions (rare). */
export const ACTION_ROSE = ACTION_GOLD;

/* ═══ TYPE 3 · SECONDARY / OUTLINE BUTTONS — cyan on slate ════════════════ */

const OUTLINE =
  `${IX} rounded-lg border-2 bg-transparent font-bold ` +
  "hover:scale-105 active:scale-95 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[#0F1117]";

/** Default secondary: Back / Cancel / Reset / Refresh. */
export const OUTLINE_CYAN =
  `${OUTLINE} border-[#06B6D4] text-[#06B6D4] hover:bg-slate-800 hover:text-white focus:ring-cyan-300`;

/** Accent secondary: open-page / jump-to-destination actions. */
export const OUTLINE_AMBER = OUTLINE_CYAN;

/** Destructive secondary: Delete, cancel-edit. */
export const OUTLINE_ROSE =
  `${OUTLINE} border-rose-400 text-rose-300 hover:bg-slate-800 hover:text-white focus:ring-rose-300`;

/** Neutral secondary: Close, JSON export, dismiss banners. */
export const OUTLINE_NEUTRAL =
  `${OUTLINE} border-slate-700 text-slate-400 hover:border-[#06B6D4] hover:bg-slate-800 hover:text-white focus:ring-cyan-300`;

/* ═══ TYPE 4 · INTERACTIVE CARDS — solid elevated slate ═══════════════════ */

/**
 * Fully clickable cards (match cards, league cards, expandable slip rows).
 * Lifts physically on hover, gains depth shadow + a glowing top border.
 * `border-t-2 border-t-transparent` is set at rest so the glow adds no layout
 * shift when it appears.
 */
export const CARD_CLICK =
  `${IX} block w-full rounded-2xl border border-slate-700 border-t-2 border-t-transparent bg-slate-800 ` +
  "hover:-translate-y-2 hover:border-t-amber-400 hover:bg-slate-700 hover:shadow-2xl hover:shadow-amber-500/20 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60";

/** Same physical lift for live fixtures — glow burns rose instead of amber. */
export const CARD_CLICK_LIVE =
  `${IX} block w-full rounded-2xl border border-slate-700 border-t-2 border-t-transparent bg-slate-800 ` +
  "hover:-translate-y-2 hover:border-t-rose-400 hover:bg-slate-700 hover:shadow-2xl hover:shadow-rose-500/20 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60";

/**
 * Card surfaces that contain buttons but aren't one big click target
 * (accumulator cards, saved-slip shells). Same elevated-slate language,
 * no global cursor-pointer, gentler lift.
 */
export const CARD_SURFACE =
  "rounded-2xl border border-slate-700 bg-slate-800 transition-all duration-200 " +
  "hover:-translate-y-1 hover:border-t-2 hover:border-t-amber-400/70 hover:shadow-2xl hover:shadow-amber-500/10";

/* ═══ TYPE 10 · GLASS FIXTURE CARDS — translucent deck over the slideshow ══ */
/*
 * Fixture cards float over the BackgroundSlideshow as a coloured glass deck:
 * a dark translucent wash + backdrop-blur keeps text legible while the
 * slideshow imagery bleeds through. Each card wears one accent skin
 * (amber → teal → violet → cyan → rose → emerald, cycled by list position)
 * so long match lists get a premium visual rhythm.
 */

/** Accent keys for the glass card deck. */
export type CardAccent = "amber" | "teal" | "violet" | "cyan" | "rose" | "emerald";

/** Repeating colour cycle used when callers pass a list index. */
export const CARD_ACCENT_ORDER: readonly CardAccent[] = [
  "amber",
  "teal",
  "violet",
  "cyan",
  "rose",
  "emerald",
];

/**
 * Structural glass baseline shared by every fixture card: translucent dark
 * surface, backdrop-blur so the slideshow shows through, physical hover lift
 * and a lit 2px top edge (colour supplied by the accent skin).
 */
export const CARD_GLASS =
  `${IX} block w-full rounded-2xl border border-white/[0.08] border-t-2 backdrop-blur-xl ` +
  "shadow-lg shadow-black/40 hover:-translate-y-2 hover:shadow-2xl " +
  "focus:outline-none focus-visible:ring-2";

/**
 * Per-accent glass skin: tinted diagonal wash, glowing top edge, and a
 * matching hover glow + focus ring. Combine as `${CARD_GLASS} ${skin}`.
 */
export const CARD_GLASS_SKIN: Record<CardAccent, string> = {
  amber:
    "bg-gradient-to-br from-amber-400/[0.12] via-slate-950/40 to-slate-950/55 border-t-amber-400/60 " +
    "hover:border-t-amber-300 hover:from-amber-400/[0.20] hover:shadow-amber-500/25 focus-visible:ring-amber-400/70",
  teal:
    "bg-gradient-to-br from-teal-400/[0.12] via-slate-950/40 to-slate-950/55 border-t-teal-400/60 " +
    "hover:border-t-teal-300 hover:from-teal-400/[0.20] hover:shadow-teal-500/25 focus-visible:ring-teal-400/70",
  violet:
    "bg-gradient-to-br from-violet-400/[0.12] via-slate-950/40 to-slate-950/55 border-t-violet-400/60 " +
    "hover:border-t-violet-300 hover:from-violet-400/[0.20] hover:shadow-violet-500/25 focus-visible:ring-violet-400/70",
  cyan:
    "bg-gradient-to-br from-cyan-400/[0.12] via-slate-950/40 to-slate-950/55 border-t-cyan-400/60 " +
    "hover:border-t-cyan-300 hover:from-cyan-400/[0.20] hover:shadow-cyan-500/25 focus-visible:ring-cyan-400/70",
  rose:
    "bg-gradient-to-br from-rose-400/[0.12] via-slate-950/40 to-slate-950/55 border-t-rose-400/60 " +
    "hover:border-t-rose-300 hover:from-rose-400/[0.20] hover:shadow-rose-500/25 focus-visible:ring-rose-400/70",
  emerald:
    "bg-gradient-to-br from-emerald-400/[0.12] via-slate-950/40 to-slate-950/55 border-t-emerald-400/60 " +
    "hover:border-t-emerald-300 hover:from-emerald-400/[0.20] hover:shadow-emerald-500/25 focus-visible:ring-emerald-400/70",
};

/**
 * Subtle dark text shadow that keeps every label legible when the glass
 * surface sits over a bright patch of the background slideshow.
 * `text-shadow` inherits, so applying it on the card root covers all children.
 */
export const GLASS_TEXT_SHADOW = "[text-shadow:0_1px_4px_rgba(2,4,10,0.85)]";

/* ═══ TYPE 5 · FILTER CHIPS / LEAGUE PILLS — solid slate tags ═════════════ */

/**
 * Small scannable toggles. `border-l-4` is always present (transparent when
 * off) so activating a chip never shifts layout — the accent bar just ignites.
 */
export const CHIP =
  `${IX} inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border-l-4 border-l-transparent ` +
  "active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60";

/** Inactive chip: solid slate tag. */
export const CHIP_OFF = "bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white";

/** Active chip variants: solid colour + bold left accent bar. */
export const CHIP_ON_AMBER = "border-l-[#FF8C00] bg-[#F59E0B] font-bold text-white hover:bg-[#FF8C00]";
export const CHIP_ON_EMERALD = "border-l-emerald-400 bg-emerald-600 font-bold text-white hover:bg-emerald-500";
export const CHIP_ON_CYAN = "border-l-cyan-400 bg-cyan-600 font-bold text-white hover:bg-cyan-500";
export const CHIP_ON_ROSE = "border-l-rose-400 bg-rose-600 font-bold text-white hover:bg-rose-500";
export const CHIP_ON_VIOLET = CHIP_ON_AMBER;

/* ═══ TYPE 7 · PREMIUM GLASS SURFACES — for header, chips, dropdowns ═══════ */

export const GLASS_PANEL =
  "bg-white/[0.03] border border-white/[0.08] backdrop-blur-2xl shadow-[0_0_30px_-10px_rgba(245,158,11,0.15)]";

export const GLASS_PILL_CONTAINER =
  "flex gap-1 rounded-full border border-white/[0.08] bg-white/[0.04] backdrop-blur-xl p-1 shadow-inner shadow-black/20";

export const GLASS_DROPDOWN =
  "bg-[#080a10]/95 backdrop-blur-2xl border border-white/[0.08] shadow-[0_30px_60px_-15px_rgba(0,0,0,0.85)]";

export const GOLD_GLOW_LINE =
  "absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-amber-400/60 to-transparent";

/* ═══ TYPE 8 · PREMIUM CHIP / PILL TOKENS ═══════════════════════════════════ */

export const CHIP_PREMIUM =
  `${IX} inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-white/[0.08] bg-white/[0.05] ` +
  "hover:bg-white/[0.1] hover:border-white/[0.15] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60";

export const CHIP_PREMIUM_ON_AMBER =
  "bg-gradient-to-r from-[#F59E0B] to-[#FF8C00] border-amber-300/30 text-white font-bold shadow-[0_0_20px_-5px_rgba(245,158,11,0.5)]";

export const CHIP_PREMIUM_ON_EMERALD =
  "bg-gradient-to-r from-emerald-500 to-emerald-400 border-emerald-300/40 text-white font-bold shadow-[0_0_20px_-5px_rgba(16,185,129,0.5)]";

/* ═══ TYPE 9 · NAV PILL PREMIUM ════════════════════════════════════════════ */

export const NAV_PILL_PREMIUM =
  `${IX} inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium tracking-wide ` +
  "hover:scale-[1.03] active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60";

export const NAV_PILL_PREMIUM_OFF =
  "bg-white/[0.06] text-slate-300 border border-transparent hover:bg-white/[0.1] hover:text-white hover:border-white/[0.08]";

export const NAV_PILL_PREMIUM_ON =
  `bg-gradient-to-br from-[#F59E0B] to-[#FF8C00] text-white font-bold shadow-[0_0_25px_-8px_rgba(245,158,11,0.55)] scale-[1.05]`;

/* ═══ TYPE 6 · MENU / DROPDOWN ITEMS — smooth slide-in links ═══════════════ */

/**
 * Flat list items inside menus & sidebars. Hover slides the row right and
 * ignites a bright left border. Left border exists at rest (transparent) to
 * avoid layout shift.
 */
export const MENU_ITEM =
  `${IX} block rounded-lg border-l-4 border-l-transparent text-slate-400 ` +
  "hover:translate-x-1 hover:border-l-amber-400 hover:bg-slate-800 hover:text-white active:scale-[0.98] " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60";

/** Currently-selected menu row keeps the accent lit. */
export const MENU_ITEM_ON = "border-l-amber-400 bg-slate-800 font-bold text-white";
