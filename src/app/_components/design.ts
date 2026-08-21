// ─────────────────────────────────────────────────────────────────────────────
// ĞIGI GIVØ — Interactive Design System
//
// One central source of truth for every clickable element in the app.
// Each archetype has its OWN unique, unmistakable design language:
//
//   TYPE 1 · NAV_PILL     — Primary navigation (header tabs & pills).
//                           Bold, glowing, "glass-tech" fully-rounded pills.
//   TYPE 2 · ACTION_*     — Primary action buttons (Submit, Verify, Save…).
//                           Solid, heavy, rounded-xl CTAs with coloured glow.
//   TYPE 3 · OUTLINE_*    — Secondary / outline buttons (Cancel, Back, Reset).
//                           Sleek, minimal, border-focused rounded-lg buttons.
//   TYPE 4 · CARD_*       — Interactive cards (match / league / slip cards).
//                           Physical "elevated paper" with a glowing top edge.
//   TYPE 5 · CHIP_*       — Filter chips / league pills (small toggles).
//                           Compact duotone tags with a bold left accent bar.
//   TYPE 6 · MENU_ITEM    — Menu / dropdown items (slide-in list links).
//                           Flat items that slide right with a bright left bar.
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

/* ═══ TYPE 1 · PRIMARY NAVIGATION — glass-tech pills ═══════════════════════ */

export const NAV_PILL =
  `${IX} inline-flex items-center gap-1.5 whitespace-nowrap rounded-full backdrop-blur-sm ` +
  "hover:scale-105 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70";

/** Inactive pill: frosted glass, thin border, muted text, slight elevation. */
export const NAV_PILL_OFF =
  "border border-white/10 bg-white/10 text-white/60 shadow-sm hover:bg-white/15 hover:text-white";

/** Active pill (main app): vibrant amber→orange gradient with a coloured glow. */
export const NAV_PILL_ON_AMBER =
  "scale-105 bg-gradient-to-r from-amber-400 to-orange-500 font-bold text-white shadow-lg shadow-amber-500/50";

/** Active pill (performance section): violet→fuchsia gradient glow. */
export const NAV_PILL_ON_VIOLET =
  "scale-105 bg-gradient-to-r from-violet-500 to-fuchsia-500 font-bold text-white shadow-lg shadow-fuchsia-500/50";

/* ═══ TYPE 2 · PRIMARY ACTION BUTTONS — solid, heavy CTAs ══════════════════ */

const ACTION =
  `${IX} rounded-xl font-bold shadow-2xl hover:scale-105 hover:shadow-2xl active:scale-95 ` +
  // Dark overlay gradient on hover (lays over the solid colour — never transparent).
  "hover:bg-gradient-to-b hover:from-black/30 hover:to-transparent " +
  "focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[#05070d] " +
  "disabled:pointer-events-none disabled:opacity-50";

/** Success actions: Verify, Save, Run Backtest, Re-verify, Track confirmation. */
export const ACTION_EMERALD =
  `${ACTION} bg-emerald-500 text-white shadow-emerald-500/30 focus:ring-emerald-300`;

/** Brand actions: Send, Convert, Add, Start Tracking, Track Slip, Set PIN. */
export const ACTION_AMBER =
  `${ACTION} bg-amber-500 text-slate-950 shadow-amber-500/30 focus:ring-amber-300`;

/** Info actions: Retry, Try Again, Resolve Pending (Web Search). */
export const ACTION_BLUE =
  `${ACTION} bg-blue-500 text-white shadow-blue-500/30 focus:ring-blue-300`;

/** Destructive primary actions (rare). */
export const ACTION_ROSE =
  `${ACTION} bg-rose-500 text-white shadow-rose-500/30 focus:ring-rose-300`;

/* ═══ TYPE 3 · SECONDARY / OUTLINE BUTTONS — sleek, border-focused ═════════ */

const OUTLINE =
  `${IX} rounded-lg border-2 bg-transparent font-bold ` +
  "hover:scale-105 active:scale-95 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[#05070d]";

/** Default secondary: Back / Cancel / Reset / Refresh. */
export const OUTLINE_CYAN =
  `${OUTLINE} border-cyan-400 text-cyan-400 hover:bg-cyan-400/10 focus:ring-cyan-300`;

/** Accent secondary: open-page / jump-to-destination actions. */
export const OUTLINE_AMBER =
  `${OUTLINE} border-amber-400 text-amber-300 hover:bg-amber-400/10 focus:ring-amber-300`;

/** Destructive secondary: Delete, cancel-edit. */
export const OUTLINE_ROSE =
  `${OUTLINE} border-rose-400 text-rose-300 hover:bg-rose-400/10 focus:ring-rose-300`;

/** Neutral secondary: Close, JSON export, dismiss banners. */
export const OUTLINE_NEUTRAL =
  `${OUTLINE} border-white/40 text-slate-200 hover:border-white/70 hover:bg-white/10 hover:text-white focus:ring-white/50`;

/* ═══ TYPE 4 · INTERACTIVE CARDS — physical "elevated paper" ═══════════════ */

/**
 * Fully clickable cards (match cards, league cards, expandable slip rows).
 * Lifts physically on hover, gains depth shadow + a glowing top border.
 * `border-t-2 border-t-transparent` is set at rest so the glow adds no layout
 * shift when it appears.
 */
export const CARD_CLICK =
  `${IX} block w-full rounded-2xl border border-white/5 border-t-2 border-t-transparent bg-white/5 ` +
  "hover:-translate-y-2 hover:border-t-amber-400 hover:bg-white/[0.07] hover:shadow-2xl hover:shadow-amber-500/20 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60";

/** Same physical lift for live fixtures — glow burns rose instead of amber. */
export const CARD_CLICK_LIVE =
  `${IX} block w-full rounded-2xl border border-white/5 border-t-2 border-t-transparent bg-white/5 ` +
  "hover:-translate-y-2 hover:border-t-rose-400 hover:bg-white/[0.07] hover:shadow-2xl hover:shadow-rose-500/20 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60";

/**
 * Card surfaces that contain buttons but aren't one big click target
 * (accumulator cards, saved-slip shells). Same elevated-paper language,
 * no global cursor-pointer, gentler lift.
 */
export const CARD_SURFACE =
  "rounded-2xl border border-white/5 bg-white/5 transition-all duration-200 " +
  "hover:-translate-y-1 hover:border-t-2 hover:border-t-amber-400/70 hover:shadow-2xl hover:shadow-amber-500/10";

/* ═══ TYPE 5 · FILTER CHIPS / LEAGUE PILLS — compact duotone tags ══════════ */

/**
 * Small scannable toggles. `border-l-4` is always present (transparent when
 * off) so activating a chip never shifts layout — the accent bar just ignites.
 */
export const CHIP =
  `${IX} inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border-l-4 border-l-transparent ` +
  "active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60";

/** Inactive chip: duotone grey tag. */
export const CHIP_OFF = "bg-gray-800/50 text-gray-400 hover:bg-white/10 hover:text-slate-200";

/** Active chip variants: tinted duotone + bold left accent bar. */
export const CHIP_ON_AMBER = "border-l-amber-500 bg-amber-500/20 font-bold text-amber-300 hover:bg-amber-500/30";
export const CHIP_ON_EMERALD = "border-l-emerald-500 bg-emerald-500/20 font-bold text-emerald-300 hover:bg-emerald-500/30";
export const CHIP_ON_CYAN = "border-l-cyan-500 bg-cyan-500/20 font-bold text-cyan-300 hover:bg-cyan-500/30";
export const CHIP_ON_ROSE = "border-l-rose-500 bg-rose-500/20 font-bold text-rose-300 hover:bg-rose-500/30";
export const CHIP_ON_VIOLET = "border-l-violet-500 bg-violet-500/20 font-bold text-violet-300 hover:bg-violet-500/30";

/* ═══ TYPE 6 · MENU / DROPDOWN ITEMS — smooth slide-in links ═══════════════ */

/**
 * Flat list items inside menus & sidebars. Hover slides the row right and
 * ignites a bright left border. Left border exists at rest (transparent) to
 * avoid layout shift.
 */
export const MENU_ITEM =
  `${IX} block rounded-lg border-l-4 border-l-transparent text-white/70 ` +
  "hover:translate-x-1 hover:border-l-amber-400 hover:bg-white/5 hover:text-white active:scale-[0.98] " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60";

/** Currently-selected menu row keeps the accent lit. */
export const MENU_ITEM_ON = "border-l-amber-400 bg-white/5 font-bold text-white";
