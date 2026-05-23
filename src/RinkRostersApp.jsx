import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// ─── UA flags (mobile safe-area + Visual Viewport tuning) ──────────────────
// Used by the body-class useEffect below so mobile.css can layer per-platform
// padding floors on .rr-mob-sidebar. Same pattern as FCRoster.
const IS_FIREFOX = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent || '')
const IS_ANDROID = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '')
const IS_IOS     = typeof navigator !== 'undefined'
  && /iPad|iPhone|iPod/.test(navigator.userAgent || '')
  && !(typeof window !== 'undefined' && window.MSStream)

// ─── NHL rink geometry (top-down, ft) ─────────────────────────────────────────
// Rink is 200×85 with 28-ft corner radius. Coordinates use feet so positioning
// math reads like NHL diagrams: red line at x=100, blue lines at 75 / 125,
// goal lines at 11 / 189, faceoff dots and creases at NHL-correct spots.
const RINK = {
  W: 200, H: 85, R: 28,
  RED: 100,
  BLUE_L: 75, BLUE_R: 125,
  GOAL_L: 11, GOAL_R: 189,
  DOT_Y_T: 20.5, DOT_Y_B: 64.5,
  ZONE_DOT_X_L: 20, ZONE_DOT_X_R: 180,
  NEUTRAL_DOT_X_L: 80, NEUTRAL_DOT_X_R: 120,
  FACEOFF_R: 15,
  CREASE_R: 6,
  TRAP_DEPTH: 11, // trapezoid extends to goal line
}

// ─── Slot positions on the rink for each view / format ────────────────────────
// Forwards live in offensive zone (right side), D at the blue line, G in own
// net. Each slot has { key, label, x, y, pos } where `pos` is the eligibility
// position. PP/PK slots use pos='SKATER' which accepts any non-goalie.
const SLOTS = {
  // Even Strength
  ES_5v5: [
    { key: 'G',  label: 'G',  x: 12,  y: 42.5, pos: 'G'  },
    { key: 'LD', label: 'LD', x: 115, y: 25,   pos: 'LD' },
    { key: 'RD', label: 'RD', x: 115, y: 60,   pos: 'RD' },
    { key: 'LW', label: 'LW', x: 155, y: 18,   pos: 'LW' },
    { key: 'C',  label: 'C',  x: 155, y: 42.5, pos: 'C'  },
    { key: 'RW', label: 'RW', x: 155, y: 67,   pos: 'RW' },
  ],
  ES_4v4: [
    { key: 'G',  label: 'G',  x: 12,  y: 42.5, pos: 'G'  },
    { key: 'LD', label: 'LD', x: 115, y: 28,   pos: 'LD' },
    { key: 'RD', label: 'RD', x: 115, y: 57,   pos: 'RD' },
    { key: 'LW', label: 'LW', x: 158, y: 25,   pos: 'LW' },
    { key: 'RW', label: 'RW', x: 158, y: 60,   pos: 'RW' },
  ],
  ES_3v3: [
    { key: 'G', label: 'G', x: 12, y: 42.5, pos: 'G' },
    { key: 'D', label: 'D', x: 120, y: 42.5, pos: 'LD' }, // accepts LD or RD via family
    { key: 'F1', label: 'F', x: 160, y: 28, pos: 'C' },
    { key: 'F2', label: 'F', x: 160, y: 57, pos: 'C' },
  ],
  // Power Play (5 skaters, generic) -- 1-3-1 look, spread wide so the chips and
  // their name plates don't collide (esp. on the squashed mobile rink).
  PP: [
    { key: 'G',  label: 'G',  x: 12,  y: 42.5, pos: 'G' },
    { key: 'P1', label: 'PT', x: 95,  y: 42.5, pos: 'SKATER' }, // QB / point
    { key: 'P2', label: 'LW', x: 140, y: 14,   pos: 'SKATER' }, // L half-wall
    { key: 'P3', label: 'BU', x: 152, y: 42.5, pos: 'SKATER' }, // bumper / slot
    { key: 'P4', label: 'RW', x: 140, y: 71,   pos: 'SKATER' }, // R half-wall
    { key: 'P5', label: 'NF', x: 186, y: 42.5, pos: 'SKATER' }, // net-front
  ],
  // Penalty Kill (4 skaters, generic) -- box in D-zone, opened up for legibility.
  // D pair sits well off the goalie so the crease isn't crowded.
  PK: [
    { key: 'G',  label: 'G',  x: 12, y: 42.5, pos: 'G' },
    { key: 'K1', label: 'F',  x: 70, y: 20,   pos: 'SKATER' },
    { key: 'K2', label: 'F',  x: 70, y: 65,   pos: 'SKATER' },
    { key: 'K3', label: 'D',  x: 42, y: 28,   pos: 'SKATER' },
    { key: 'K4', label: 'D',  x: 42, y: 57,   pos: 'SKATER' },
  ],
}

const FORMAT_KEYS = ['5v5', '4v4', '3v3']
const POSITIONS = ['C', 'LW', 'RW', 'LD', 'RD', 'G']
const POSITION_FAMILY = { C: 'F', LW: 'F', RW: 'F', LD: 'D', RD: 'D', G: 'G' }

const STORAGE_KEY = 'rinkrosters.v1'
const TEAMS_KEY = 'rinkrosters.teams.v1'

// "My Teams" (named local snapshots) is hidden for now: it's slated to move to
// account sign-in + Supabase cloud sync for real cross-device security. Flip to
// true to re-expose the existing local-storage version. Hiding only removes the
// UI entry point — the autosave working copy and any saved snapshots are kept.
const ENABLE_MY_TEAMS = false

// Typography. DISPLAY_FONT (Oswald, self-hosted via mobile.css @font-face) is a
// condensed athletic face used only for chrome — wordmark, view tabs, selector
// labels, modal titles. Player names, numbers and the SVG/canvas chip text stay
// on BODY_FONT (system-ui) for legibility and PNG-export parity (the canvas
// redraw hard-codes system-ui — these must not diverge).
const DISPLAY_FONT = "'Oswald', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
const BODY_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

// Goalie accent — a gold rim marking goalie-eligible players across every render
// path (rink, roster chip, depth chart). Deliberately distinct from the amber
// Move-mode ring (#fbbf24) and the off-position warning ring (#f59e0b) so the
// three never read as the same cue.
const GOALIE_GOLD = '#f5c542'

// Frosted-glass surface for modal/popover panels (the "frosted ice" look). The
// translucent solid bg already reads fine where backdrop-filter is unsupported,
// so no feature-detection is needed. Kept to transient overlays only — never the
// always-on rink — to bound blur cost on low-end mobile.
const GLASS_PANEL = {
  background: 'rgba(14,23,34,0.72)',
  backdropFilter: 'blur(14px)',
  WebkitBackdropFilter: 'blur(14px)',
  border: '1px solid rgba(255,255,255,0.08)',
  boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
}

// Faint skate-shaving texture (very low-opacity curved strokes) tiled behind the
// rink as a CSS background. Inline data-URI so it ships in the bundle with no
// extra request and caches with the app shell.
const ICE_TEXTURE = `url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='150'%20height='150'%3E%3Cg%20fill='none'%20stroke='%23ffffff'%20stroke-opacity='0.04'%20stroke-width='1.3'%20stroke-linecap='round'%3E%3Cpath%20d='M12%2046%20q22%20-13%2044%200'/%3E%3Cpath%20d='M70%20104%20q26%20-15%2050%200'/%3E%3Cpath%20d='M-8%20116%20q22%20-13%2044%200'/%3E%3Cpath%20d='M38%2014%20q20%20-11%2040%200'/%3E%3Cpath%20d='M96%2060%20q22%20-13%2044%200'/%3E%3C/g%3E%3C/svg%3E")`

// Fixed ice tint — no longer user-configurable (jersey-only color model).
const ICE_FILL = '#eaf2fb'
// SVG margin (ft) around the rink inside the viewBox; shared by render + hit-test.
const RINK_M = 4

// Mobile-only compression of the rink's long axis (portrait mode) so the board
// fills the phone's width instead of leaving big side gutters. The full-length
// 200×85 rink is ~2.35:1, far taller than a phone's rink area, so it gutters;
// squashing the length makes it chunkier and wider. Player chips are
// counter-scaled to stay perfectly round — only the rink markings/faceoff
// circles take the squash (they go slightly oval). Set to 1 to fully revert.
const MOBILE_RINK_SQUASH = 0.72

// ─── Defaults ─────────────────────────────────────────────────────────────────
// Only the jersey color is user-chosen. Number + trim are derived from it via
// readableOn() for guaranteed contrast; ice is fixed (ICE_FILL).
const DEFAULT_COLORS = {
  jerseyPrimary: '#1d4ed8', // royal blue
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

function emptyState() {
  return {
    roster: [],
    lines: {
      forwards: [emptyFwd(), emptyFwd(), emptyFwd(), emptyFwd()],
      defense: [emptyDef(), emptyDef(), emptyDef()],
      pp: [emptyPP(), emptyPP()],
      pk: [emptyPK(), emptyPK()],
      goalies: { starter: null, backup: null, emergency: null },
    },
    view: { mode: 'ES', selectedLine: 0, selectedPair: 0, selectedUnit: 0 },
    colors: { ...DEFAULT_COLORS },
    format: '5v5',
    // Free-placement overrides: posKey → { x, y } in landscape rink feet. When a
    // token is dragged, its release spot is stored here and used for rendering +
    // hit-testing instead of the default slot position. Role/line assignment is
    // unchanged — this is purely where the chip sits on the ice.
    positions: {},
  }
}

const emptyFwd = () => ({ LW: null, C: null, RW: null })
const emptyDef = () => ({ LD: null, RD: null })
const emptyPP  = () => ({ slots: [null, null, null, null, null] })
const emptyPK  = () => ({ slots: [null, null, null, null] })

// ─── Persistence ──────────────────────────────────────────────────────────────
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyState()
    const parsed = JSON.parse(raw)
    return mergeStateShape(parsed)
  } catch {
    return emptyState()
  }
}
function saveState(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)) } catch {}
}

// ── Named local saves ("My Teams") ──────────────────────────────────────────
// The single autosave above (STORAGE_KEY) is always the live working copy.
// Named teams are independent snapshots in TEAMS_KEY so a coach can keep more
// than one roster on the device and swap between them. Cloud/profile sync is a
// future phase; this is local-only and survives reloads, not device changes.
function loadTeams() {
  try {
    const raw = localStorage.getItem(TEAMS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}
function persistTeams(teams) {
  try { localStorage.setItem(TEAMS_KEY, JSON.stringify(teams)) } catch {}
}
// Tolerate older snapshots / missing fields so a saved state from an earlier
// build still loads cleanly. New fields fall back to defaults.
function mergeStateShape(s) {
  const base = emptyState()
  if (!s || typeof s !== 'object') return base
  return {
    roster: Array.isArray(s.roster) ? s.roster.map(normalizePlayer) : base.roster,
    lines: {
      forwards: padArr(s.lines?.forwards, 4, emptyFwd),
      defense:  padArr(s.lines?.defense, 3, emptyDef),
      pp:       padArr(s.lines?.pp, 2, emptyPP),
      pk:       padArr(s.lines?.pk, 2, emptyPK),
      goalies: { ...base.lines.goalies, ...(s.lines?.goalies || {}) },
    },
    view: { ...base.view, ...(s.view || {}) },
    colors: { ...base.colors, ...(s.colors || {}) },
    format: FORMAT_KEYS.includes(s.format) ? s.format : '5v5',
    positions: (s.positions && typeof s.positions === 'object') ? s.positions : {},
  }
}
function normalizePlayer(p) {
  return {
    id: p.id || newId(),
    number: String(p.number ?? ''),
    name: String(p.name ?? ''),
    handedness: p.handedness === 'L' ? 'L' : 'R',
    eligibility: Array.isArray(p.eligibility) ? p.eligibility.filter(x => POSITIONS.includes(x)) : [],
    notes: String(p.notes ?? ''),
  }
}
function padArr(arr, n, factory) {
  const out = Array.isArray(arr) ? arr.slice(0, n) : []
  while (out.length < n) out.push(factory())
  return out
}

// ─── Eligibility ──────────────────────────────────────────────────────────────
// ES slots enforce exact position match (LW only takes LW-eligible).
// PP/PK slots are skater-generic — any non-goalie passes.
// G slot is exclusive to goalies. 3v3's combined D slot accepts either LD or RD.
function isEligible(player, slot) {
  if (!player) return false
  const elig = player.eligibility || []
  if (slot.pos === 'G') return elig.includes('G')
  if (slot.pos === 'SKATER') return elig.some(p => p !== 'G')
  if (slot.key === 'D') return elig.includes('LD') || elig.includes('RD') // 3v3 combined D
  return elig.includes(slot.pos)
}

// Sensible default eligibility for a player created by typing directly into an
// empty rink slot, so the freshly placed chip doesn't immediately show the
// off-position warning ring. Coaches refine it later via the details editor.
function defaultEligForSlot(slot) {
  if (!slot) return []
  if (slot.pos === 'G') return ['G']
  if (slot.key === 'D') return ['LD', 'RD'] // 3v3 combined D accepts either
  if (slot.pos === 'SKATER') return ['C']   // PP/PK generic skater
  return [slot.pos]
}

// Pointer travel (screen px) below which a press counts as a tap, not a drag.
// Finger-friendly: a deliberate tap jitters a few px; a real drag clears this.
const TAP_SLOP = 5

// Pure: return a new `lines` object with `playerId` written into `target`'s slot.
// Shared by drag-drop assignment and create-and-place so both stay in lockstep.
function placeInLines(lines, target, playerId) {
  const next = { ...lines }
  if (target.kind === 'ES_F') {
    next.forwards = next.forwards.map((f, i) => i === target.lineIdx ? { ...f, [target.role]: playerId } : f)
  } else if (target.kind === 'ES_D') {
    next.defense = next.defense.map((d, i) => i === target.pairIdx ? { ...d, [target.role]: playerId } : d)
  } else if (target.kind === 'PP') {
    next.pp = next.pp.map((u, i) => i === target.unitIdx ? { ...u, slots: u.slots.map((p, j) => j === target.slotIdx ? playerId : p) } : u)
  } else if (target.kind === 'PK') {
    next.pk = next.pk.map((u, i) => i === target.unitIdx ? { ...u, slots: u.slots.map((p, j) => j === target.slotIdx ? playerId : p) } : u)
  } else if (target.kind === 'G') {
    next.goalies = { ...next.goalies, [target.role]: playerId }
  }
  return next
}

// Mobile-only chip nudges (landscape ft) so chips clear the rink lines/faceoff
// circles once the portrait squash tightens spacing. Verified to clear all
// lines/circles across ES 5v5 / 4v4 / 3v3. Keyed by slot.key; only render +
// hit-test positions shift (slot keys/targets are unchanged). Desktop: no-op.
const MOBILE_SLOT_NUDGE = {
  G:  { dx: 10, dy: 0 },
  LW: { dx: -10, dy: 0 },
  RW: { dx: -10, dy: 0 },
  F1: { dx: -11, dy: 0 },
  F2: { dx: -11, dy: 0 },
  D:  { dx: 0, dy: -9 },
}
function nudgeSlots(slots, vertical) {
  if (!vertical) return slots
  return slots.map(s => {
    const n = MOBILE_SLOT_NUDGE[s.key]
    return n ? { ...s, x: s.x + n.dx, y: s.y + n.dy } : s
  })
}

// ─── Color helpers ────────────────────────────────────────────────────────────
function readableOn(hex) {
  // Pick black or white for max contrast against a hex background.
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16) || 0
  const g = parseInt(h.slice(2, 4), 16) || 0
  const b = parseInt(h.slice(4, 6), 16) || 0
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.6 ? '#0b1118' : '#ffffff'
}

// Swatch palette for the two-click color popover. Hockey-relevant team colors
// up front, then a neutral row, then bright accent options.
const SWATCHES = [
  '#1d4ed8', '#dc2626', '#000000', '#ffffff', '#f59e0b', '#16a34a',
  '#a16207', '#7c3aed', '#0891b2', '#be123c', '#374151', '#94a3b8',
  '#fef3c7', '#fee2e2', '#e0e7ff', '#dcfce7', '#fae8ff', '#f1f5f9',
]

// ════════════════════════════════════════════════════════════════════════════
// Main app
// ════════════════════════════════════════════════════════════════════════════
export default function RinkRostersApp() {
  const [state, setState] = useState(loadState)
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state; saveState(state) }, [state])

  // Body-class flags so mobile.css can scope per-platform overrides on
  // .rr-mob-sidebar et al. Android Chrome reports env(safe-area-inset-bottom)
  // as 0 even with the gesture nav bar present, and iOS Safari reports 0 when
  // its bottom toolbar is shown — the class-scoped floors compensate.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    if (IS_FIREFOX) root.classList.add('is-firefox')
    if (IS_ANDROID) root.classList.add('is-android')
    if (IS_IOS)     root.classList.add('is-ios')
    if (navigator && navigator.brave && typeof navigator.brave.isBrave === 'function') {
      navigator.brave.isBrave().then((yes) => { if (yes) root.classList.add('is-brave') }).catch(() => {})
    }
  }, [])

  // Visual Viewport offset: how many CSS pixels the browser chrome (Safari's
  // collapsing bottom bar, soft keyboard, etc.) is currently eating from the
  // layout viewport. Exposed as --vv-offset so .rr-mob-sidebar rides the
  // chrome instead of leaving a dead gap. Defaults to 0 when the API is
  // absent (older Firefox / older Android Chrome).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const update = () => {
      const raw = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      // The soft keyboard also shrinks the visual viewport, but with
      // interactive-widget=overlays-content the layout viewport stays put, so a
      // large offset means "keyboard" not "collapsed browser chrome". Padding
      // the sidebar by the keyboard height would squeeze the rink (the bug we're
      // fixing), so ignore large offsets — only small chrome-collapse offsets ride.
      const offset = raw > 140 ? 0 : raw
      root.style.setProperty('--vv-offset', offset + 'px')
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update()
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  // Drag is owned by refs (avoid re-rendering 60×/sec on pointermove); only
  // the lightweight dragGhost / hover state goes through React.
  const dragRef = useRef(null) // { source: {kind, ...}, playerId, startX, startY, moved }
  const [dragGhost, setDragGhost] = useState(null) // { playerId, x, y } in screen coords
  const [hoverSlot, setHoverSlot] = useState(null) // { unitKey, slotKey } or 'BENCH'

  const rinkRef = useRef(null)
  const rinkGroupRef = useRef(null) // inner <g data-rink-rotate> (reserved; hit-testing uses the root svg CTM)
  const rosterRef = useRef(null)
  const [pickerFor, setPickerFor] = useState(null) // 'jerseyPrimary' | null
  const [editPlayerId, setEditPlayerId] = useState(null) // open the edit modal for this player
  // Tap on a rink slot opens an inline name editor at the tap point.
  // { source, slotKey, playerId|null, x, y } — playerId null ⇒ empty slot (create + place).
  const [inlineEdit, setInlineEdit] = useState(null)
  // Edit (default) → tap a slot to name/rename a player; Move → drag a token to
  // any slot. Explicit modes so tap and drag never fight on a touch screen.
  const [moveMode, setMoveMode] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  // Tap a placed token in Edit mode → roster picker to swap who plays that spot.
  const [pickFor, setPickFor] = useState(null) // { source, slotKey, playerId }
  // Opt-in drag diagnostics (load with ?debug=1) — a small on-screen HUD that
  // reports the live gesture state so touch issues can be pinpointed on-device.
  const [dbg, setDbg] = useState(null)
  const DEBUG = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug')
  const [teamsOpen, setTeamsOpen] = useState(false)
  const [teams, setTeams] = useState(loadTeams)

  const { roster, lines, view, colors, format, positions } = state

  // Mobile → portrait rink. Computed up here (not just at render) so the drag
  // hit-tester below can invert the rotation when mapping screen → rink coords.
  const screen = useScreen()
  const mobile = screen.width < 880
  const vertical = mobile

  // ── Lookup helpers ──────────────────────────────────────────────────────
  const playerById = useCallback((id) => roster.find(p => p.id === id) || null, [roster])

  // What gets shown on the rink, given the current mode + selected line/pair/unit.
  const activeUnit = useMemo(() => {
    if (view.mode === 'ES') {
      const slots = SLOTS[`ES_${format}`]
      const fwd = lines.forwards[view.selectedLine] || emptyFwd()
      const def = lines.defense[view.selectedPair] || emptyDef()
      const filled = {}
      slots.forEach(s => {
        if (s.key === 'G') filled[s.key] = lines.goalies.starter
        else if (s.key === 'C' || s.key === 'LW' || s.key === 'RW') filled[s.key] = fwd[s.key] || null
        else if (s.key === 'LD' || s.key === 'RD') filled[s.key] = def[s.key] || null
        else if (s.key === 'F1') filled[s.key] = fwd.LW || fwd.C || null
        else if (s.key === 'F2') filled[s.key] = fwd.RW || null
        else if (s.key === 'D')  filled[s.key] = def.LD || def.RD || null
        else filled[s.key] = null
      })
      return { slots, filled, unitKind: 'ES' }
    }
    if (view.mode === 'PP') {
      const slots = SLOTS.PP
      const unit = lines.pp[view.selectedUnit] || emptyPP()
      const filled = { G: lines.goalies.starter }
      slots.forEach((s, i) => {
        if (s.key === 'G') return
        const slotIdx = slots.filter(x => x.key !== 'G').findIndex(x => x.key === s.key)
        filled[s.key] = unit.slots[slotIdx] || null
      })
      return { slots, filled, unitKind: 'PP' }
    }
    // PK
    const slots = SLOTS.PK
    const unit = lines.pk[view.selectedUnit] || emptyPK()
    const filled = { G: lines.goalies.starter }
    slots.forEach((s) => {
      if (s.key === 'G') return
      const slotIdx = slots.filter(x => x.key !== 'G').findIndex(x => x.key === s.key)
      filled[s.key] = unit.slots[slotIdx] || null
    })
    return { slots, filled, unitKind: 'PK' }
  }, [view, format, lines])

  // Stable key for a slot's free-placement override. Forwards track the selected
  // line, D the selected pair, G is shared across views; PP/PK track their unit.
  // (So repositioning L1 doesn't disturb L2, etc.)
  const posKey = useCallback((slotKey) => {
    if (view.mode === 'ES') {
      if (slotKey === 'G') return 'G'
      if (slotKey === 'LD' || slotKey === 'RD' || slotKey === 'D') return `ESD_${format}_${view.selectedPair}_${slotKey}`
      return `ESF_${format}_${view.selectedLine}_${slotKey}`
    }
    if (view.mode === 'PP') return `PP_${view.selectedUnit}_${slotKey}`
    return `PK_${view.selectedUnit}_${slotKey}`
  }, [view, format])

  // Positions used for rendering + hit-testing: start from the slot's default
  // spot (nudged off the rink lines on mobile), then apply any free-placement
  // override the coach has dragged a token to.
  const dispSlots = useMemo(() => {
    const nudged = nudgeSlots(activeUnit.slots, vertical)
    return nudged.map(s => {
      const cp = positions[posKey(s.key)]
      return cp ? { ...s, x: cp.x, y: cp.y } : s
    })
  }, [activeUnit, vertical, positions, posKey])

  // Store where a token was dropped (landscape feet), clamped just inside the boards.
  function setSlotPos(slotKey, x, y) {
    const cx = Math.max(3, Math.min(RINK.W - 3, x))
    const cy = Math.max(3, Math.min(RINK.H - 3, y))
    setState(s => ({ ...s, positions: { ...s.positions, [posKey(slotKey)]: { x: cx, y: cy } } }))
  }

  // ── Mutations ───────────────────────────────────────────────────────────
  function addPlayer(p) {
    setState(s => ({ ...s, roster: s.roster.concat([normalizePlayer({ ...p, id: newId() })]) }))
  }
  function updatePlayer(id, patch) {
    setState(s => ({ ...s, roster: s.roster.map(p => p.id === id ? normalizePlayer({ ...p, ...patch }) : p) }))
  }
  function deletePlayer(id) {
    setState(s => {
      // Clear this player from every line/unit they appear in.
      const stripF = f => ({ LW: f.LW===id?null:f.LW, C: f.C===id?null:f.C, RW: f.RW===id?null:f.RW })
      const stripD = d => ({ LD: d.LD===id?null:d.LD, RD: d.RD===id?null:d.RD })
      const stripSlots = u => ({ slots: u.slots.map(x => x===id ? null : x) })
      return {
        ...s,
        roster: s.roster.filter(p => p.id !== id),
        lines: {
          forwards: s.lines.forwards.map(stripF),
          defense:  s.lines.defense.map(stripD),
          pp:       s.lines.pp.map(stripSlots),
          pk:       s.lines.pk.map(stripSlots),
          goalies: {
            starter:   s.lines.goalies.starter   === id ? null : s.lines.goalies.starter,
            backup:    s.lines.goalies.backup    === id ? null : s.lines.goalies.backup,
            emergency: s.lines.goalies.emergency === id ? null : s.lines.goalies.emergency,
          },
        },
      }
    })
  }

  function setColor(k, v) {
    setState(s => ({ ...s, colors: { ...s.colors, [k]: v } }))
  }

  // ── Slot assignment ─────────────────────────────────────────────────────
  // assignToSlot(target, playerId): place a player into a unit slot. The same
  // player can appear on multiple units (top-line C + PP1 + PK1 is normal).
  // Eligibility is a soft guide, not a hard gate: an out-of-position drop is
  // allowed and flagged with a warning ring on the rink (coaches routinely try
  // players off their natural spot). Returns true if applied.
  function assignToSlot(target, playerId) {
    const player = playerById(playerId)
    if (!player) return false
    if (!resolveSlotDef(target)) return false
    setState(s => ({ ...s, lines: placeInLines(s.lines, target, playerId) }))
    return true
  }

  // Create a brand-new roster player from a typed name and drop them straight
  // into the slot — the empty-slot inline-edit path. Done in one setState so the
  // roster append and the line placement land together (and the new chip shows
  // immediately). Eligibility defaults to the slot's natural position.
  function createAndPlace(target, slot, name) {
    const player = normalizePlayer({ id: newId(), name, eligibility: defaultEligForSlot(slot), handedness: 'R' })
    // Position is a property of the spot, not the player: a token created in a
    // slot inherits wherever that marker was dragged to (no reset). Reset clears all.
    setState(s => ({
      ...s,
      roster: s.roster.concat([player]),
      lines: placeInLines(s.lines, target, player.id),
    }))
  }

  function clearSlot(target) {
    setState(s => {
      const lines = { ...s.lines }
      if (target.kind === 'ES_F') {
        lines.forwards = lines.forwards.map((f, i) => i === target.lineIdx ? { ...f, [target.role]: null } : f)
      } else if (target.kind === 'ES_D') {
        lines.defense = lines.defense.map((d, i) => i === target.pairIdx ? { ...d, [target.role]: null } : d)
      } else if (target.kind === 'PP') {
        lines.pp = lines.pp.map((u, i) => i === target.unitIdx ? { ...u, slots: u.slots.map((p, j) => j === target.slotIdx ? null : p) } : u)
      } else if (target.kind === 'PK') {
        lines.pk = lines.pk.map((u, i) => i === target.unitIdx ? { ...u, slots: u.slots.map((p, j) => j === target.slotIdx ? null : p) } : u)
      } else if (target.kind === 'G') {
        lines.goalies = { ...lines.goalies, [target.role]: null }
      }
      return { ...s, lines }
    })
  }

  // Put `newPid` into the tapped slot. If that player already holds another spot
  // in the current view, the two trade places (true swap); otherwise the player
  // who was in the tapped slot is displaced (becomes unplaced in this view).
  function assignToSlotWithSwap(tappedSlotKey, newPid) {
    const tappedTarget = rinkSlotToTarget(tappedSlotKey)
    if (!tappedTarget) return
    const displaced = activeUnit.filled[tappedSlotKey] || null
    const otherKey = Object.keys(activeUnit.filled).find(k => activeUnit.filled[k] === newPid && k !== tappedSlotKey)
    setState(s => {
      let lines = placeInLines(s.lines, tappedTarget, newPid)
      if (otherKey) {
        const otherTarget = rinkSlotToTarget(otherKey)
        if (otherTarget) lines = placeInLines(lines, otherTarget, displaced)
      }
      return { ...s, lines }
    })
  }

  // Maps a rink slot to its drop target descriptor for the *currently* active line.
  function rinkSlotToTarget(slotKey) {
    if (view.mode === 'ES') {
      if (slotKey === 'G') return { kind: 'G', role: 'starter' }
      if (slotKey === 'C' || slotKey === 'LW' || slotKey === 'RW' || slotKey === 'F1' || slotKey === 'F2') {
        const role = slotKey === 'F1' ? 'LW' : (slotKey === 'F2' ? 'RW' : slotKey)
        return { kind: 'ES_F', lineIdx: view.selectedLine, role }
      }
      if (slotKey === 'LD' || slotKey === 'RD' || slotKey === 'D') {
        const role = slotKey === 'D' ? 'LD' : slotKey
        return { kind: 'ES_D', pairIdx: view.selectedPair, role }
      }
    } else if (view.mode === 'PP') {
      if (slotKey === 'G') return { kind: 'G', role: 'starter' }
      const slots = SLOTS.PP.filter(x => x.key !== 'G')
      const idx = slots.findIndex(s => s.key === slotKey)
      return { kind: 'PP', unitIdx: view.selectedUnit, slotIdx: idx }
    } else if (view.mode === 'PK') {
      if (slotKey === 'G') return { kind: 'G', role: 'starter' }
      const slots = SLOTS.PK.filter(x => x.key !== 'G')
      const idx = slots.findIndex(s => s.key === slotKey)
      return { kind: 'PK', unitIdx: view.selectedUnit, slotIdx: idx }
    }
    return null
  }

  function resolveSlotDef(target) {
    if (target.kind === 'G') return { pos: 'G' }
    if (target.kind === 'ES_F') return { pos: target.role }
    if (target.kind === 'ES_D') return { pos: target.role }
    if (target.kind === 'PP' || target.kind === 'PK') return { pos: 'SKATER' }
    return null
  }

  // ── Drag-and-drop (pointer events; works for mouse, pen, and touch) ─────
  // We use pointer events with explicit touch-action: none on the draggable
  // surfaces so iOS/Android don't hijack the gesture for scrolling. The
  // gesture state lives in refs (60Hz writes); only the floating ghost +
  // hovered slot trigger React renders.
  // playerId may be null: an empty rink slot still starts a gesture so a clean
  // tap can open the inline name editor (create + place). A drag of a real
  // player relocates it; tap vs drag is decided purely by pointer travel.
  function beginDrag(e, sourceDesc, playerId, allowMove) {
    e.preventDefault?.()
    const pt = pointerXY(e)
    // Capture the pointer on the pressed element so Android/iOS can't reinterpret
    // the gesture as a scroll and fire pointercancel mid-drag (the "tokens won't
    // move" bug). Released automatically on pointerup.
    let captured = false
    try { e.currentTarget?.setPointerCapture?.(e.pointerId); captured = true } catch { /* unsupported */ }
    dragRef.current = { source: sourceDesc, playerId: playerId || null, startX: pt.x, startY: pt.y, moved: false, moves: 0, allowMove: !!allowMove }
    // Ghost + hover rings only appear once the press becomes a real drag (see
    // onDragMove), so a tap reads as a clean click with no flicker.
    window.addEventListener('pointermove', onDragMove, { passive: false })
    window.addEventListener('pointerup', onDragEnd, { passive: false })
    window.addEventListener('pointercancel', onDragEnd, { passive: false })
    // Some Android browsers fire touchmove faster than pointermove; back it up.
    window.addEventListener('touchmove', preventDefault, { passive: false })
    if (DEBUG) setDbg({ phase: 'down', src: sourceDesc.kind, pid: !!playerId, captured, ptr: e.pointerType, moves: 0, moved: false, end: '', hover: '' })
  }
  function onDragMove(e) {
    const d = dragRef.current
    if (!d) return
    e.preventDefault?.()
    const pt = pointerXY(e)
    d.moves = (d.moves || 0) + 1
    const dx = Math.abs(pt.x - d.startX), dy = Math.abs(pt.y - d.startY)
    if (!d.moved && (dx > TAP_SLOP || dy > TAP_SLOP)) d.moved = true
    if (d.moved && d.allowMove) {
      // Ghost follows the finger: a jersey for a real player, or a dashed marker
      // (with the slot label) when dragging an empty position.
      setDragGhost({ playerId: d.playerId, label: d.source.label, x: pt.x, y: pt.y })
      // Bench drags snap into a slot, so show slot highlights. Rink drags are
      // free placement (no snapping) — only surface the bench-removal cue.
      const h = detectHover(pt)
      setHoverSlot(d.source.kind === 'BENCH' ? h : (h === 'BENCH' ? h : null))
    }
    if (DEBUG) setDbg(s => s ? { ...s, phase: 'move', moves: d.moves, moved: d.moved } : s)
  }
  function onDragEnd(e) {
    const d = dragRef.current
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragEnd)
    window.removeEventListener('pointercancel', onDragEnd)
    window.removeEventListener('touchmove', preventDefault)
    if (!d) { setDragGhost(null); setHoverSlot(null); return }
    const pt = pointerXY(e)
    dragRef.current = null
    setDragGhost(null)
    setHoverSlot(null)
    const hover = detectHover(pt)
    if (DEBUG) setDbg(s => s ? { ...s, phase: 'end', end: e.type + (d.moved ? ' drag' : ' tap'), moves: d.moves, moved: d.moved, hover: hover && hover.kind ? hover.slotKey : String(hover) } : s)

    // Bench: a tap opens the full edit modal; a drag places onto the rink.
    if (d.source.kind === 'BENCH') {
      if (!d.moved) { setEditPlayerId(d.playerId); return }
      if (hover && hover.kind === 'RINK_SLOT') {
        const target = rinkSlotToTarget(hover.slotKey)
        if (target) assignToSlot(target, d.playerId)
      }
      return
    }

    // Rink slot, Edit mode (no drag action here):
    //  • empty slot → quick name editor (type a name to create + place);
    //  • filled token → roster picker to swap who plays that spot.
    if (!d.allowMove) {
      if (d.playerId) setPickFor({ source: d.source, slotKey: d.source.slotKey, playerId: d.playerId })
      else setInlineEdit({ source: d.source, slotKey: d.source.slotKey, playerId: d.playerId, x: pt.x, y: pt.y })
      return
    }

    // Rink slot, Move mode: free placement for any spot — a filled token or an
    // empty position marker — stays exactly where the thumb lifts. Dropping a
    // filled token over the roster drawer removes it. A plain tap does nothing.
    if (!d.moved) return
    if (d.playerId && hover === 'BENCH') { clearSlot(d.source); return }
    const f = screenToFeet(pt)
    if (f) setSlotPos(d.source.slotKey, f.fx, f.fy)
  }
  // Map a screen pixel to rink feet coordinates. We take the transform off the
  // *root* <svg> (getScreenCTM there is well-defined and letterbox/viewBox-correct
  // across browsers) and undo the portrait wrap (rotate -90° + squash) ourselves —
  // reading getScreenCTM off the inner rotated <g> is unreliable because browsers
  // disagree on whether it includes that element's own transform.
  function screenToFeet(pt) {
    const svg = rinkRef.current
    if (!svg || !svg.getScreenCTM || !svg.createSVGPoint) return null
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const sp = svg.createSVGPoint(); sp.x = pt.x; sp.y = pt.y
    const vb = sp.matrixTransform(ctm.inverse()) // point in viewBox units
    if (vertical) {
      const VB_W = RINK.W + RINK_M * 2
      const sq = MOBILE_RINK_SQUASH
      const VB_L = VB_W * sq
      return { fx: (VB_L - vb.y) / sq - RINK_M, fy: vb.x - RINK_M }
    }
    return { fx: vb.x - RINK_M, fy: vb.y - RINK_M }
  }
  // Nearest slot to a screen point, within `radiusFt`, else null.
  function nearestSlot(pt, radiusFt) {
    const f = screenToFeet(pt)
    if (!f) return null
    let best = null, bestD = Infinity
    for (const s of dispSlots) {
      const dx = s.x - f.fx, dy = s.y - f.fy, d2 = dx*dx + dy*dy
      if (d2 < bestD) { bestD = d2; best = s }
    }
    return best && bestD < radiusFt * radiusFt ? best.key : null
  }
  function detectHover(pt) {
    // Generous 12 ft catch radius so coaches don't have to be pixel-perfect.
    const slotKey = nearestSlot(pt, 12)
    if (slotKey) return { kind: 'RINK_SLOT', slotKey }
    const roster = rosterRef.current
    if (roster) {
      const r = roster.getBoundingClientRect()
      if (pt.x >= r.left && pt.x <= r.right && pt.y >= r.top && pt.y <= r.bottom) return 'BENCH'
    }
    return null
  }
  // Tighter radius for the initial press (you should grab near a token).
  function hitSlot(pt) { return nearestSlot(pt, 11) }

  // Single pointer entry point for the whole rink. Handling the press on the
  // rink container (an HTML div) instead of the individual SVG shapes sidesteps
  // flaky touch/pointer delivery on inline SVG elements — the press always lands
  // on one reliable surface, and getScreenCTM tells us which token/slot it hit.
  function onRinkPointerDown(e) {
    const pt = pointerXY(e)
    const slotKey = hitSlot(pt)
    if (!slotKey) return
    const pid = activeUnit.filled[slotKey] || null
    const target = rinkSlotToTarget(slotKey)
    if (!target) return
    // In Move mode every spot is draggable — filled tokens *and* empty position
    // markers (so a coach can arrange the layout before naming anyone). The slot
    // label rides along for the empty-marker drag ghost.
    const label = activeUnit.slots.find(s => s.key === slotKey)?.label
    beginDrag(e, { ...target, slotKey, label }, pid, moveMode)
  }

  function sameSlot(a, b) {
    if (!a || !b || a.kind !== b.kind) return false
    if (a.kind === 'ES_F') return a.lineIdx === b.lineIdx && a.role === b.role
    if (a.kind === 'ES_D') return a.pairIdx === b.pairIdx && a.role === b.role
    if (a.kind === 'PP' || a.kind === 'PK') return a.unitIdx === b.unitIdx && a.slotIdx === b.slotIdx
    if (a.kind === 'G') return a.role === b.role
    return false
  }

  // ── Reset lineup ─────────────────────────────────────────────────────────
  // Clears every on-ice placement (lines, pairs, PP/PK units, goalies) back to
  // empty. The roster of players and colors are kept — only the arrangement
  // resets, so a coach can re-build from a clean sheet after experimenting.
  function resetLineup() {
    if (!window.confirm('Reset the lineup? This clears all players off the rink. Your roster is kept.')) return
    setState(s => ({ ...s, lines: emptyState().lines, positions: {} }))
  }

  // ── Auto-fill the whole lineup from the roster ────────────────────────────
  // Fills every EMPTY spot — 4 forward lines, 3 D pairs, the starting goalie,
  // and both PP + PK units — leaving anything already placed untouched. Players
  // are distinct within each group (a coach can't be on two ES lines at once),
  // but ES / PP / PK draw independently, so a two-way player can appear on all
  // three (as in real hockey). No skill data exists, so it goes in roster order
  // by eligible position, then backfills leftover spots with any spare skater —
  // a sensible starting point the coach then tweaks (tap a token to swap).
  function autoFillLineup() {
    const hasPos = (p, pos) => (p.eligibility || []).includes(pos)
    const isF = p => hasPos(p, 'C') || hasPos(p, 'LW') || hasPos(p, 'RW')
    const isD = p => hasPos(p, 'LD') || hasPos(p, 'RD')
    // Skater = anyone who isn't a pure goalie (unknown/no-position players count
    // as skaters so "fill everything" can still seat them via backfill).
    const skaters = roster.filter(p => { const e = p.eligibility || []; return e.length === 0 || e.some(x => x !== 'G') })
    const goalies = roster.filter(p => hasPos(p, 'G'))
    if (!skaters.length && !goalies.length) { window.alert('Add players to your roster first, then auto-fill.'); return }

    setState(s => {
      const lines = {
        forwards: s.lines.forwards.map(f => ({ ...f })),
        defense:  s.lines.defense.map(d => ({ ...d })),
        pp:       s.lines.pp.map(u => ({ slots: u.slots.slice() })),
        pk:       s.lines.pk.map(u => ({ slots: u.slots.slice() })),
        goalies:  { ...s.lines.goalies },
      }

      // Even strength — distinct across all forward + D slots.
      const usedES = new Set()
      lines.forwards.forEach(f => ['LW', 'C', 'RW'].forEach(r => f[r] && usedES.add(f[r])))
      lines.defense.forEach(d => ['LD', 'RD'].forEach(r => d[r] && usedES.add(d[r])))
      const takeES = pred => { for (const p of skaters) if (!usedES.has(p.id) && pred(p)) { usedES.add(p.id); return p.id } return null }
      lines.forwards.forEach(f => {
        if (!f.LW) f.LW = takeES(p => hasPos(p, 'LW'))
        if (!f.C)  f.C  = takeES(p => hasPos(p, 'C'))
        if (!f.RW) f.RW = takeES(p => hasPos(p, 'RW'))
      })
      lines.defense.forEach(d => {
        if (!d.LD) d.LD = takeES(p => hasPos(p, 'LD'))
        if (!d.RD) d.RD = takeES(p => hasPos(p, 'RD'))
      })
      // Backfill leftover ES spots with any spare skater (soft eligibility).
      lines.forwards.forEach(f => ['LW', 'C', 'RW'].forEach(r => { if (!f[r]) f[r] = takeES(() => true) }))
      lines.defense.forEach(d => ['LD', 'RD'].forEach(r => { if (!d[r]) d[r] = takeES(() => true) }))

      // Goalie — starter only.
      if (!lines.goalies.starter && goalies.length) lines.goalies.starter = goalies[0].id

      // Special teams — fill empty slots only, distinct within each group.
      const fillUnits = (units, pattern) => {
        const used = new Set()
        units.forEach(u => u.slots.forEach(id => id && used.add(id)))
        const take = pred => { for (const p of skaters) if (!used.has(p.id) && pred(p)) { used.add(p.id); return p.id } return null }
        units.forEach(u => {
          u.slots.forEach((id, i) => { if (!id) u.slots[i] = take(pattern[i] === 'D' ? isD : isF) })
          u.slots.forEach((id, i) => { if (!u.slots[i]) u.slots[i] = take(() => true) })
        })
      }
      fillUnits(lines.pp, ['D', 'F', 'F', 'F', 'F'])
      fillUnits(lines.pk, ['F', 'F', 'D', 'D'])

      return { ...s, lines }
    })
  }

  // ── Named local saves ("My Teams") ──────────────────────────────────────
  function commitTeams(next) { setTeams(next); persistTeams(next) }
  function saveCurrentAsTeam(name) {
    const team = {
      id: newId(),
      name: name.trim() || `Team ${teams.length + 1}`,
      savedAt: Date.now(),
      state: JSON.parse(JSON.stringify(stateRef.current)),
    }
    commitTeams([team, ...teams])
  }
  function overwriteTeam(id) {
    commitTeams(teams.map(t => t.id === id
      ? { ...t, savedAt: Date.now(), state: JSON.parse(JSON.stringify(stateRef.current)) }
      : t))
  }
  function loadTeam(id) {
    const t = teams.find(x => x.id === id)
    if (!t) return
    setState(mergeStateShape(t.state))
    setTeamsOpen(false)
  }
  function renameTeam(id, name) {
    commitTeams(teams.map(t => t.id === id ? { ...t, name: name.trim() || t.name } : t))
  }
  function deleteTeam(id) {
    commitTeams(teams.filter(t => t.id !== id))
  }

  // ── PNG export ──────────────────────────────────────────────────────────
  // Pattern ported from FC-Roster: clone the live SVG, serialize, load via
  // blob URL into an Image, then drawImage onto a canvas with programmatic
  // header / footer. Player chips are re-drawn programmatically on top so
  // browsers don't need to support nested fonts/foreignObject in SVG-to-PNG.
  function exportPng() {
    const svg = rinkRef.current
    if (!svg) return
    const clone = svg.cloneNode(true)
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    // Strip all interactive chrome (drop-zone outlines, hover glows) before serializing.
    clone.querySelectorAll('[data-export-strip]').forEach(el => el.remove())
    // Render the rink image LANDSCAPE in all cases (clean, round faceoff circles):
    // neutralize the rotation wrapper + per-chip counter-spins and reset the
    // viewBox to the landscape frame. Chips are redrawn programmatically below,
    // so the (now-unrotated) SVG chips underneath don't matter. For mobile the
    // composited canvas then rotates this image -90° into portrait (matching the
    // on-screen orientation) — see `portrait` in img.onload.
    const M = RINK_M
    const VB_W = RINK.W + M * 2
    const VB_H = RINK.H + M * 2
    clone.setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`)
    clone.querySelector('[data-rink-rotate]')?.removeAttribute('transform')
    clone.querySelectorAll('[data-spin]').forEach(el => el.removeAttribute('transform'))

    const SCALE = 2
    const PW = Math.round(520 * SCALE)
    const PH = Math.round(PW * (VB_H / VB_W))
    clone.setAttribute('width', PW)
    clone.setAttribute('height', PH)

    const xml = new XMLSerializer().serializeToString(clone)
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const PAD = 24 * SCALE
      const HDR = 56 * SCALE
      const FTR = 36 * SCALE
      // Mobile exports portrait to match the on-screen vertical rink; desktop
      // stays landscape. The rink image is always rendered landscape (above), so
      // portrait just rotates it -90° at composite time and places the (upright)
      // chips at the rotated coordinates. Header/footer stay upright either way.
      const portrait = vertical
      const rinkW = portrait ? PH : PW
      const rinkH = portrait ? PW : PH
      const CW = rinkW + PAD * 2
      const CH = HDR + rinkH + FTR + PAD * 2

      const canvas = document.createElement('canvas')
      canvas.width = CW; canvas.height = CH
      const ctx = canvas.getContext('2d')

      ctx.fillStyle = '#0b1118'
      ctx.fillRect(0, 0, CW, CH)

      // Header
      ctx.fillStyle = '#111b27'
      ctx.fillRect(0, 0, CW, HDR + PAD)
      ctx.textAlign = 'center'
      ctx.fillStyle = 'rgba(255,255,255,0.95)'
      ctx.font = `bold ${18 * SCALE}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
      ctx.fillText('RINKROSTERS', CW / 2, PAD + 22 * SCALE)
      ctx.fillStyle = 'rgba(76,194,255,0.85)'
      ctx.font = `${10 * SCALE}px system-ui, -apple-system, sans-serif`
      ctx.fillText(viewLabel(view, format), CW / 2, PAD + 40 * SCALE)

      // Rink — rotate the landscape image -90° for portrait, else draw it flat.
      const rinkX = PAD, rinkY = PAD + HDR
      if (portrait) {
        ctx.save()
        ctx.translate(rinkX, rinkY + PW)
        ctx.rotate(-Math.PI / 2)
        ctx.drawImage(img, 0, 0, PW, PH)
        ctx.restore()
      } else {
        ctx.drawImage(img, rinkX, rinkY, PW, PH)
      }
      URL.revokeObjectURL(url)

      // Player chips overlaid programmatically (more reliable than SVG text).
      // Apply any free-placement override (stored in landscape feet); skip the
      // mobile-only nudges. Portrait maps the same landscape feet through the
      // -90° rotation so chips line up with the rotated rink image.
      const sx = PW / RINK.W, sy = PH / RINK.H
      for (const s of activeUnit.slots) {
        const pid = activeUnit.filled[s.key]
        const p = pid ? playerById(pid) : null
        if (!p) continue
        const cp = positions[posKey(s.key)]
        const fx = cp ? cp.x : s.x, fy = cp ? cp.y : s.y
        const cx = portrait ? rinkX + fy * sy : rinkX + fx * sx
        const cy = portrait ? rinkY + PW - fx * sx : rinkY + fy * sy
        drawJerseyCanvas(ctx, cx, cy, 11 * SCALE, p, colors)
      }

      // Footer
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.font = `${9 * SCALE}px system-ui, -apple-system, sans-serif`
      ctx.fillText('rinkrosters.com', CW / 2, CH - PAD / 2)

      canvas.toBlob(b => {
        if (!b) return
        const a = document.createElement('a')
        a.href = URL.createObjectURL(b)
        a.download = `rinkrosters-${viewFilename(view, format)}.png`
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 1000)
      }, 'image/png')
    }
    img.onerror = () => URL.revokeObjectURL(url)
    img.src = url
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: mobile ? 'column' : 'row', background: '#0b1118' }}>
      {/* Rink area */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Header
          view={view}
          format={format}
          onView={(patch) => setState(s => ({ ...s, view: { ...s.view, ...patch } }))}
          onFormat={(f) => setState(s => ({ ...s, format: f }))}
          onExportPng={exportPng}
          onOpenTeams={() => setTeamsOpen(true)}
          onAutoFill={autoFillLineup}
          onPickColor={setPickerFor}
          colors={colors}
          mobile={mobile}
        />
        <LineSelector view={view} lines={lines} onView={(patch) => setState(s => ({ ...s, view: { ...s.view, ...patch } }))} />
        <div
          onPointerDown={onRinkPointerDown}
          style={{
            flex: 1, minHeight: 0, position: 'relative', display: 'flex', alignItems: 'stretch', justifyContent: 'center',
            touchAction: 'none', cursor: moveMode ? 'grab' : 'pointer',
            // Faint skate-shaving texture behind the rink. A container background
            // (not a child layer) so it can't intercept pointer events — the
            // getScreenCTM hit-testing stays exact — and, living outside rinkRef,
            // it never appears in the PNG export.
            backgroundImage: ICE_TEXTURE,
            backgroundSize: '150px 150px',
            // Amber inset ring while Move mode is active — an ambient cue that
            // drag-to-reposition is live (mirrors the toggle's amber half).
            boxShadow: moveMode ? 'inset 0 0 0 3px #fbbf24' : 'none',
            transition: 'box-shadow 0.12s',
          }}>
          <Rink
            innerRef={rinkRef}
            groupRef={rinkGroupRef}
            slots={dispSlots}
            filled={activeUnit.filled}
            playerById={playerById}
            colors={colors}
            vertical={vertical}
            hoverSlot={hoverSlot && hoverSlot.kind === 'RINK_SLOT' ? hoverSlot.slotKey : null}
            dragPlayerId={dragGhost?.playerId || null}
            isDragEligible={(slotKey) => {
              if (!dragGhost) return null
              const slot = activeUnit.slots.find(s => s.key === slotKey)
              return slot ? isEligible(playerById(dragGhost.playerId), slot) : null
            }}
          />
        </div>
        <ModeToggle moveMode={moveMode} onSet={setMoveMode} onHelp={() => setHelpOpen(true)} onReset={resetLineup} mobile={mobile} />
      </div>

      {/* Roster sidebar / drawer */}
      <Sidebar
        mobile={mobile}
        innerRef={rosterRef}
        roster={roster}
        lines={lines}
        view={view}
        colors={colors}
        hoverBench={hoverSlot === 'BENCH'}
        dragPlayerId={dragGhost?.playerId || null}
        onBeginDrag={(e, pid) => beginDrag(e, { kind: 'BENCH' }, pid, true)}
        onAddPlayer={() => setEditPlayerId('NEW')}
        onEditPlayer={(id) => setEditPlayerId(id)}
        playerById={playerById}
      />

      {/* Drag ghost (follows pointer) — jersey for a player, dashed marker for
          an empty position being repositioned. */}
      {dragGhost && (() => {
        const p = dragGhost.playerId ? playerById(dragGhost.playerId) : null
        return (
          <div style={{ position: 'fixed', left: dragGhost.x - 24, top: dragGhost.y - 24, width: 48, height: 48, pointerEvents: 'none', zIndex: 100, opacity: 0.92 }}>
            {p ? <JerseyChip player={p} colors={colors} size={48} /> : (
              <div style={{
                width: 48, height: 48, borderRadius: '50%', border: '2px dashed #94a3b8',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#cbd5e1', fontWeight: 700, fontSize: 14, background: 'rgba(11,17,24,0.55)',
              }}>{dragGhost.label || ''}</div>
            )}
          </div>
        )
      })()}

      {/* Drag diagnostics HUD (?debug=1) */}
      {DEBUG && (
        <div style={{
          position: 'fixed', top: 8, right: 8, zIndex: 500, pointerEvents: 'none',
          background: 'rgba(2,6,12,0.92)', color: '#7dd3fc', border: '1px solid #334155',
          borderRadius: 8, padding: '8px 10px', fontSize: 11, fontFamily: 'ui-monospace, monospace', lineHeight: 1.5,
        }}>
          <div style={{ color: '#fbbf24', fontWeight: 700 }}>drag debug · {moveMode ? 'MOVE' : 'EDIT'}</div>
          {dbg ? (
            <>
              <div>phase: {dbg.phase}</div>
              <div>src: {dbg.src} · pid: {String(dbg.pid)}</div>
              <div>ptr: {dbg.ptr} · captured: {String(dbg.captured)}</div>
              <div>moves: {dbg.moves} · moved: {String(dbg.moved)}</div>
              <div>end: {dbg.end || '—'} · hover: {dbg.hover || '—'}</div>
            </>
          ) : <div>press a token…</div>}
        </div>
      )}

      {/* Color popover */}
      {pickerFor && (
        <ColorPopover
          target={pickerFor}
          value={colors[pickerFor]}
          onPick={(c) => { setColor(pickerFor, c); setPickerFor(null) }}
          onClose={() => setPickerFor(null)}
        />
      )}

      {/* Ice controls help */}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}

      {/* My Teams (named local saves) — hidden pending account + Supabase sync */}
      {ENABLE_MY_TEAMS && teamsOpen && (
        <TeamsModal
          teams={teams}
          rosterCount={roster.length}
          onSaveNew={saveCurrentAsTeam}
          onOverwrite={overwriteTeam}
          onLoad={loadTeam}
          onRename={renameTeam}
          onDelete={deleteTeam}
          onClose={() => setTeamsOpen(false)}
        />
      )}

      {/* Player edit modal */}
      {editPlayerId && (
        <PlayerModal
          player={editPlayerId === 'NEW' ? null : playerById(editPlayerId)}
          onSave={(data) => {
            if (editPlayerId === 'NEW') addPlayer(data)
            else updatePlayer(editPlayerId, data)
            setEditPlayerId(null)
          }}
          onDelete={editPlayerId !== 'NEW' ? () => { deletePlayer(editPlayerId); setEditPlayerId(null) } : null}
          onClose={() => setEditPlayerId(null)}
        />
      )}

      {/* Inline name editor (tap a rink slot) */}
      {inlineEdit && (() => {
        const isNew = !inlineEdit.playerId
        const p = isNew ? null : playerById(inlineEdit.playerId)
        const slot = activeUnit.slots.find(s => s.key === inlineEdit.slotKey)
        return (
          <InlineNameEditor
            initialName={p?.name || ''}
            slotLabel={slot?.label || ''}
            isNew={isNew}
            onCommit={(name) => {
              const trimmed = name.trim()
              if (isNew) {
                // Name is optional — create the token even when blank so it can
                // be placed/moved now and named later (a blank placeholder chip).
                createAndPlace(inlineEdit.source, slot, trimmed)
              } else {
                updatePlayer(inlineEdit.playerId, { name: trimmed })
              }
              setInlineEdit(null)
            }}
            onRemove={isNew ? null : () => { clearSlot(inlineEdit.source); setInlineEdit(null) }}
            onDetails={isNew ? null : () => { setEditPlayerId(inlineEdit.playerId); setInlineEdit(null) }}
            onCancel={() => setInlineEdit(null)}
          />
        )
      })()}

      {/* Tap-to-replace picker (Edit mode, filled token) */}
      {pickFor && (() => {
        const slot = activeUnit.slots.find(s => s.key === pickFor.slotKey)
        return (
          <PlayerPicker
            slotLabel={slot?.label || ''}
            slotDef={slot}
            currentId={pickFor.playerId}
            roster={roster}
            colors={colors}
            onPick={(id) => { assignToSlotWithSwap(pickFor.slotKey, id); setPickFor(null) }}
            onNew={() => { setInlineEdit({ source: pickFor.source, slotKey: pickFor.slotKey, playerId: null }); setPickFor(null) }}
            onEditCurrent={() => { setEditPlayerId(pickFor.playerId); setPickFor(null) }}
            onRemove={() => { clearSlot(pickFor.source); setPickFor(null) }}
            onClose={() => setPickFor(null)}
          />
        )
      })()}
    </div>
  )
}

// ── Helpers (module scope) ──────────────────────────────────────────────────
function pointerXY(e) {
  if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY }
  if (e.changedTouches && e.changedTouches[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY }
  return { x: e.clientX, y: e.clientY }
}
function preventDefault(e) { e.preventDefault?.() }

function viewLabel(view, format) {
  if (view.mode === 'ES') return `EVEN STRENGTH · ${format} · L${view.selectedLine + 1} · D${view.selectedPair + 1}`
  if (view.mode === 'PP') return `POWER PLAY · PP${view.selectedUnit + 1}`
  return `PENALTY KILL · PK${view.selectedUnit + 1}`
}
function viewFilename(view, format) {
  if (view.mode === 'ES') return `es-l${view.selectedLine + 1}-d${view.selectedPair + 1}-${format}`
  if (view.mode === 'PP') return `pp${view.selectedUnit + 1}`
  return `pk${view.selectedUnit + 1}`
}

function useScreen() {
  const [s, setS] = useState({ width: typeof window === 'undefined' ? 1200 : window.innerWidth })
  useEffect(() => {
    const onR = () => setS({ width: window.innerWidth })
    window.addEventListener('resize', onR)
    return () => window.removeEventListener('resize', onR)
  }, [])
  return s
}

// ════════════════════════════════════════════════════════════════════════════
// Header
// ════════════════════════════════════════════════════════════════════════════
function Header({ view, format, onView, onFormat, onExportPng, onOpenTeams, onAutoFill, onPickColor, colors, mobile }) {
  // Tighter type + padding on mobile so the wrapped header collapses to fewer
  // rows (it otherwise spilled to three on a ~390px phone, made worse by the
  // longer "Even Strength" label).
  const tabBtn = (label, mode) => (
    <button onClick={() => onView({ mode })}
      style={{
        padding: mobile ? '6px 9px' : '8px 14px',
        background: view.mode === mode ? '#1e3a8a' : 'transparent',
        color: view.mode === mode ? '#fff' : '#94a3b8',
        border: '1px solid ' + (view.mode === mode ? '#3b82f6' : '#1f2937'),
        borderRadius: 6, cursor: 'pointer', fontFamily: DISPLAY_FONT,
        fontSize: mobile ? 12 : 14, fontWeight: 600, letterSpacing: mobile ? 0.4 : 0.6,
      }}>{label}</button>
  )
  const btn = {
    padding: mobile ? '5px 8px' : '6px 10px', background: '#111b27', color: '#cbd5e1', border: '1px solid #1f2937',
    borderRadius: 6, cursor: 'pointer', fontSize: mobile ? 11 : 12,
  }
  return (
    <div className="rr-mob-header" style={{ display: 'flex', alignItems: 'center', gap: mobile ? 6 : 8, padding: mobile ? '8px 10px' : '10px 12px', borderBottom: '1px solid #1f2937', flexWrap: 'wrap' }}>
      <div style={{ fontFamily: DISPLAY_FONT, fontWeight: 700, fontSize: mobile ? 16 : 18, letterSpacing: mobile ? 0.5 : 1, marginRight: mobile ? 4 : 8 }}>
        <span style={{ color: '#4cc2ff' }}>RINK</span>ROSTERS
      </div>
      {tabBtn('Even Strength', 'ES')}
      {tabBtn('Power Play', 'PP')}
      {tabBtn('Penalty Kill', 'PK')}
      <button onClick={onAutoFill} style={{ ...btn, color: '#86efac', borderColor: '#14532d' }} title="Fill all lines, pairs, PP, PK and starting goalie from your roster (empty spots only)">Auto-fill</button>
      {view.mode === 'ES' && (
        <select value={format} onChange={(e) => onFormat(e.target.value)}
          style={{ ...btn, background: '#0b1118', padding: '7px 10px' }}>
          {FORMAT_KEYS.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
      )}
      <ColorChip label="Jersey" value={colors.jerseyPrimary} onClick={() => onPickColor('jerseyPrimary')} />
      {ENABLE_MY_TEAMS && (
        <button onClick={onOpenTeams} style={{ ...btn, color: '#4cc2ff', borderColor: '#1e3a8a' }}>Teams</button>
      )}
      <div style={{ flex: 1 }} />
      <button onClick={onExportPng} style={{ ...btn, background: '#4cc2ff', color: '#0b1118', border: '1px solid #4cc2ff', fontWeight: 700 }}>Download Lineup</button>
    </div>
  )
}

function ColorChip({ label, value, onClick }) {
  return (
    <button onClick={onClick} title={label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 8px',
        background: '#0b1118', color: '#cbd5e1',
        border: '1px solid #1f2937', borderRadius: 6,
        cursor: 'pointer', fontSize: 11,
      }}>
      <span style={{ width: 14, height: 14, borderRadius: 3, background: value, border: '1px solid rgba(255,255,255,0.18)' }} />
      {label}
    </button>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Line selector (sub-bar under header)
// ════════════════════════════════════════════════════════════════════════════
function LineSelector({ view, lines, onView }) {
  const pillRow = (count, sel, prefix, onSel) => (
    <div style={{ display: 'flex', gap: 6 }}>
      {Array.from({ length: count }).map((_, i) => (
        <button key={i} onClick={() => onSel(i)} style={{
          padding: '5px 10px', fontSize: 12, fontWeight: 600,
          background: sel === i ? '#0ea5e9' : '#0b1118',
          color: sel === i ? '#0b1118' : '#94a3b8',
          border: '1px solid ' + (sel === i ? '#0ea5e9' : '#1f2937'),
          borderRadius: 999, cursor: 'pointer',
        }}>{prefix}{i + 1}</button>
      ))}
    </div>
  )
  return (
    <div style={{ display: 'flex', gap: 16, padding: '8px 12px', borderBottom: '1px solid #1f2937', flexWrap: 'wrap', fontFamily: DISPLAY_FONT, fontSize: 13, color: '#94a3b8', alignItems: 'center' }}>
      {view.mode === 'ES' && (
        <>
          <span style={{ letterSpacing: 0.6, opacity: 0.7 }}>LINE</span>
          {pillRow(4, view.selectedLine, 'L', (i) => onView({ selectedLine: i }))}
          <span style={{ letterSpacing: 0.6, opacity: 0.7, marginLeft: 8 }}>D PAIR</span>
          {pillRow(3, view.selectedPair, 'D', (i) => onView({ selectedPair: i }))}
        </>
      )}
      {view.mode === 'PP' && (
        <>
          <span style={{ letterSpacing: 0.6, opacity: 0.7 }}>UNIT</span>
          {pillRow(2, view.selectedUnit, 'PP', (i) => onView({ selectedUnit: i }))}
        </>
      )}
      {view.mode === 'PK' && (
        <>
          <span style={{ letterSpacing: 0.6, opacity: 0.7 }}>UNIT</span>
          {pillRow(2, view.selectedUnit, 'PK', (i) => onView({ selectedUnit: i }))}
        </>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Rink SVG
// ════════════════════════════════════════════════════════════════════════════
// Segmented Edit/Move control in its own strip below the rink — both options
// always visible, the highlighted half showing the active mode. A separate "?"
// button (detached from the segment) opens the ice-controls guide.
function ModeToggle({ moveMode, onSet, onHelp, onReset, mobile }) {
  // Tighter padding/type on mobile so the segmented control + ? + Reset all sit
  // on one row (adding Reset here otherwise squeezed the toggle labels onto two
  // lines). whiteSpace:nowrap keeps each label intact; the row can wrap as a whole
  // on very narrow screens rather than breaking a label mid-word.
  const seg = (active, accent) => ({
    display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
    padding: mobile ? '7px 11px' : '8px 16px', borderRadius: 999, cursor: 'pointer',
    fontSize: mobile ? 12 : 13, fontWeight: 800, letterSpacing: 0.3, border: 'none',
    background: active ? accent : 'transparent',
    color: active ? '#0b1118' : '#94a3b8',
    transition: 'background 0.12s, color 0.12s',
  })
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap', gap: mobile ? 6 : 10, padding: '6px 8px', borderTop: '1px solid #1f2937' }}>
      <div style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 999, background: '#0b1118', border: '1px solid #334155' }}>
        <button className="rr-mob-chip rr-press" onClick={() => onSet(false)} style={seg(!moveMode, '#38bdf8')}>✎ Edit names</button>
        <button className="rr-mob-chip rr-press" onClick={() => onSet(true)} style={seg(moveMode, '#fbbf24')}>✥ Move players</button>
      </div>
      <button className="rr-mob-chip" onClick={onHelp} aria-label="Ice controls help" title="Ice controls help"
        style={{
          flexShrink: 0, width: 32, height: 32, borderRadius: '50%', cursor: 'pointer',
          background: 'transparent', color: '#94a3b8', border: '1px solid #334155',
          fontSize: 15, fontWeight: 800, lineHeight: 1,
        }}>?</button>
      <button className="rr-mob-chip rr-press" onClick={onReset} title="Clear all players and custom positions (your roster is kept)"
        style={{
          flexShrink: 0, padding: mobile ? '7px 11px' : '7px 12px', borderRadius: 999, cursor: 'pointer',
          background: 'transparent', color: '#fca5a5', border: '1px solid #7f1d1d',
          fontSize: 12, fontWeight: 700, letterSpacing: 0.3,
        }}>Reset</button>
    </div>
  )
}

// Quick reference for the on-ice controls, opened by the "?" beside the toggle.
function HelpModal({ onClose }) {
  const Row = ({ icon, title, body }) => (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div style={{ flexShrink: 0, width: 24, textAlign: 'center', fontSize: 15 }}>{icon}</div>
      <div>
        <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 13 }}>{title}</div>
        <div style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.45 }}>{body}</div>
      </div>
    </div>
  )
  return (
    <div onMouseDown={onClose} onTouchStart={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}>
      <div onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}
        style={{ ...GLASS_PANEL, borderRadius: 12, padding: 18, width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontFamily: DISPLAY_FONT, fontSize: 16, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: '#cbd5e1' }}>Ice controls</div>
        <Row icon="✎" title="Edit names" body="With Edit names on, tap an empty spot to name a new player there (blank is fine — names later). Tap a placed player to open a picker and choose who plays that spot — pick someone already on the ice and they swap places. “+ New”, “Edit”, and “Remove” are in the picker too." />
        <Row icon="✥" title="Move players" body="With Move players on, drag any spot — a player or an empty position marker — anywhere on the ice. It stays exactly where you lift your finger." />
        <Row icon="🗑" title="Remove" body="In Move players mode, drag a player down onto the Roster drawer to take them off the ice (they stay in your roster)." />
        <Row icon="🏒" title="Lines & special teams" body="The Even Strength / Power Play / Penalty Kill tabs each have their own layout. Pick the line, pair, or unit in the row above the rink." />
        <Row icon="⚡" title="Auto-fill" body="“Auto-fill” in the header seeds your whole lineup from the roster — all forward lines, D pairs, the starting goalie, and both PP & PK units — filling only empty spots (it won't disturb players you've already placed)." />
        <Row icon="⬇" title="Download & Reset" body="“Download Lineup” saves the current view as an image. “Reset” clears all players and custom positions back to the default spots (your roster is kept)." />
        <button onClick={onClose}
          style={{ alignSelf: 'flex-end', padding: '8px 16px', background: '#0ea5e9', color: '#0b1118', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
          Got it
        </button>
      </div>
    </div>
  )
}

function Rink({ innerRef, groupRef, slots, filled, playerById, colors, hoverSlot, dragPlayerId, isDragEligible, vertical }) {
  // viewBox uses a small margin around the rink so corner radius and the
  // boards' stroke have somewhere to live. Rink geometry is authored landscape
  // (200×85 ft, ~2.35:1). On mobile we render portrait by swapping the viewBox
  // and rotating the whole rink -90° via the wrapper group (attacking zone up),
  // which fills a phone's tall viewport and makes chips far bigger. Slot/marking
  // coordinates never change — only the wrapper transform. Chips and slot labels
  // get a counter-rotation (data-spin) so text stays upright; PNG export strips
  // both transforms to render landscape regardless of screen (see exportPng).
  const M = RINK_M
  const VB_W = RINK.W + M * 2
  const VB_H = RINK.H + M * 2
  // Portrait: rotate the landscape rink -90° and squash its long axis (sq).
  // Chips/labels carry the inverse scale (+ counter-rotation) so they stay round
  // and upright. PNG export strips both transforms → always clean landscape.
  const sq = vertical ? MOBILE_RINK_SQUASH : 1
  const VB_L = (VB_W * sq).toFixed(2)
  const wrap = vertical ? `translate(0 ${VB_L}) rotate(-90) scale(${sq} 1)` : undefined
  const spin = vertical ? `scale(${(1 / sq).toFixed(4)} 1) rotate(90)` : ''
  return (
    <svg
      ref={innerRef}
      viewBox={vertical ? `0 0 ${VB_H} ${VB_L}` : `0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="xMidYMid meet"
      // pointerEvents none: the rink container (an HTML div) owns all pressing
      // and dragging now (see onRinkPointerDown) — the SVG is purely visual.
      style={{ width: '100%', height: '100%', userSelect: 'none', touchAction: 'none', pointerEvents: 'none' }}
    >
      <g data-rink-rotate ref={groupRef} transform={wrap}>
      {/* Boards / ice surface */}
      <RinkBoards ice={ICE_FILL} M={M} />
      {/* Lines, dots, circles, creases, trapezoids — all NHL-correct. cs is the
          per-circle counter-scale that keeps faceoff circles round under the
          mobile long-axis squash ('' on desktop → unchanged). foR shrinks the
          faceoff radius in step with the squash so the round circles still fit
          inside the (now shorter) end zones instead of crashing the boards. */}
      <RinkMarkings M={M} cs={vertical ? ` scale(${(1 / sq).toFixed(4)} 1)` : ''} foR={RINK.FACEOFF_R * sq} />

      {/* Slot drop targets (rendered above markings, below chips) */}
      {slots.map(s => {
        const eligible = dragPlayerId ? isDragEligible(s.key) : null
        const isHover = hoverSlot === s.key
        return (
          <g key={s.key} data-export-strip>
            {dragPlayerId !== null && eligible !== null && (
              <circle
                cx={s.x + M} cy={s.y + M} r={isHover ? 7.5 : 6.2}
                fill={eligible ? (isHover ? 'rgba(34,197,94,0.30)' : 'rgba(34,197,94,0.14)')
                              : (isHover ? 'rgba(239,68,68,0.22)' : 'rgba(239,68,68,0.10)')}
                stroke={eligible ? '#22c55e' : '#ef4444'}
                strokeWidth={isHover ? 0.6 : 0.35}
                strokeDasharray={eligible ? '' : '1 0.6'}
              />
            )}
          </g>
        )
      })}

      {/* Empty slot labels (purely visual; presses are handled by the container).
          Stripped from the PNG export — the canvas redraws placed players itself. */}
      {slots.map(s => filled[s.key] ? null : (
        <g key={'lbl-' + s.key} data-export-strip transform={`translate(${s.x + M},${s.y + M})`}>
          <g data-spin transform={spin || undefined}>
            <circle cx="0" cy="0" r="5" fill="none" stroke="rgba(11,17,24,0.35)" strokeWidth="0.3" strokeDasharray="1 0.6" />
            <text x="0" y="1.4" textAnchor="middle" fontSize="3.2" fill="rgba(11,17,24,0.55)" style={{ fontFamily: 'system-ui, -apple-system, sans-serif', fontWeight: 700 }}>
              {s.label}
            </text>
          </g>
        </g>
      ))}

      {/* Player chips. Stripped from the PNG export (data-export-strip) because
          exportPng redraws them on the canvas — keeping both double-printed the
          names (and the SVG copy still carried the mobile position nudges). */}
      {slots.map(s => {
        const pid = filled[s.key]
        if (!pid) return null
        const p = playerById(pid)
        if (!p) return null
        const offPos = !isEligible(p, s) // soft position lock → warning ring
        return (
          <g key={'chip-' + s.key} data-export-strip transform={`translate(${s.x + M},${s.y + M})`}>
            {/* rr-chip-in plays once when this slot goes empty→filled (the <g>
                mounts), so placing a player or Auto-fill makes the token settle
                in. Opacity-only (no transform) — the position translate above and
                the getScreenCTM hit-testing are untouched. */}
            <g data-spin className="rr-chip-in" transform={spin || undefined}>
              {offPos && (
                <circle cx="0" cy="0" r="6.8" fill="none" stroke="#f59e0b" strokeWidth="0.6" strokeDasharray="1.2 0.8" />
              )}
              {/* Settle flash — a quick cyan pulse on landing, fades to nothing. */}
              <circle className="rr-chip-flash" cx="0" cy="0" r="6.2" fill="none" stroke="#9bdcff" strokeWidth="0.5" pointerEvents="none" />
              <JerseySvg player={p} colors={colors} size={11} />
            </g>
          </g>
        )
      })}
      </g>
    </svg>
  )
}

function RinkBoards({ ice, M }) {
  const r = RINK.R
  const W = RINK.W, H = RINK.H
  // Rounded-corner rink outline via path: start at top-left corner end and arc the 4 corners.
  const d = [
    `M ${M + r} ${M}`,
    `H ${M + W - r}`,
    `A ${r} ${r} 0 0 1 ${M + W} ${M + r}`,
    `V ${M + H - r}`,
    `A ${r} ${r} 0 0 1 ${M + W - r} ${M + H}`,
    `H ${M + r}`,
    `A ${r} ${r} 0 0 1 ${M} ${M + H - r}`,
    `V ${M + r}`,
    `A ${r} ${r} 0 0 1 ${M + r} ${M}`,
    'Z',
  ].join(' ')
  return (
    <>
      <path d={d} fill={ice} stroke="#0b1118" strokeWidth="0.7" />
    </>
  )
}

function RinkMarkings({ M, cs = '', foR = RINK.FACEOFF_R }) {
  const red = '#dc2626'
  const blue = '#1d4ed8'
  return (
    <g pointerEvents="none">
      {/* Center red line */}
      <line x1={M + RINK.RED} y1={M} x2={M + RINK.RED} y2={M + RINK.H} stroke={red} strokeWidth="0.8" />
      {/* Blue lines */}
      <line x1={M + RINK.BLUE_L} y1={M} x2={M + RINK.BLUE_L} y2={M + RINK.H} stroke={blue} strokeWidth="0.8" />
      <line x1={M + RINK.BLUE_R} y1={M} x2={M + RINK.BLUE_R} y2={M + RINK.H} stroke={blue} strokeWidth="0.8" />
      {/* Goal lines (thin red) */}
      <line x1={M + RINK.GOAL_L} y1={M + 6} x2={M + RINK.GOAL_L} y2={M + RINK.H - 6} stroke={red} strokeWidth="0.25" />
      <line x1={M + RINK.GOAL_R} y1={M + 6} x2={M + RINK.GOAL_R} y2={M + RINK.H - 6} stroke={red} strokeWidth="0.25" />

      {/* Center faceoff circle + dot. Inner data-spin group carries the
          counter-scale so the circle stays round under the squash; PNG export
          strips data-spin → correct round circle in the landscape export. */}
      <g transform={`translate(${M + RINK.RED} ${M + RINK.H / 2})`}>
        <g data-spin transform={cs || undefined}>
          <circle cx="0" cy="0" r={foR} fill="none" stroke={blue} strokeWidth="0.35" />
        </g>
      </g>
      <circle cx={M + RINK.RED} cy={M + RINK.H/2} r="0.8" fill={blue} />

      {/* Zone faceoff circles (4) + dots. On mobile, the long-axis squash pushes
          these toward the rounded end corners, so nudge them inward (toward
          center) to keep the round circles off the boards. Desktop: inset 0. */}
      {(() => { const ins = cs ? 8 : 0; return [
        [RINK.ZONE_DOT_X_L + ins, RINK.DOT_Y_T],
        [RINK.ZONE_DOT_X_L + ins, RINK.DOT_Y_B],
        [RINK.ZONE_DOT_X_R - ins, RINK.DOT_Y_T],
        [RINK.ZONE_DOT_X_R - ins, RINK.DOT_Y_B],
      ] })().map(([x, y], i) => (
        <g key={i}>
          <g transform={`translate(${M + x} ${M + y})`}>
            <g data-spin transform={cs || undefined}>
              <circle cx="0" cy="0" r={foR} fill="none" stroke={red} strokeWidth="0.35" />
            </g>
          </g>
          <circle cx={M + x} cy={M + y} r="0.8" fill={red} />
        </g>
      ))}

      {/* Neutral-zone faceoff dots (4) */}
      {[
        [RINK.NEUTRAL_DOT_X_L, RINK.DOT_Y_T],
        [RINK.NEUTRAL_DOT_X_L, RINK.DOT_Y_B],
        [RINK.NEUTRAL_DOT_X_R, RINK.DOT_Y_T],
        [RINK.NEUTRAL_DOT_X_R, RINK.DOT_Y_B],
      ].map(([x, y], i) => (
        <circle key={i} cx={M + x} cy={M + y} r="0.8" fill={red} />
      ))}

      {/* Goal creases (semicircles facing into the rink) */}
      <path d={`M ${M + RINK.GOAL_L} ${M + RINK.H/2 - RINK.CREASE_R}
              A ${RINK.CREASE_R} ${RINK.CREASE_R} 0 0 1 ${M + RINK.GOAL_L} ${M + RINK.H/2 + RINK.CREASE_R}`}
        fill="rgba(29,78,216,0.15)" stroke="#dc2626" strokeWidth="0.25" />
      <path d={`M ${M + RINK.GOAL_R} ${M + RINK.H/2 - RINK.CREASE_R}
              A ${RINK.CREASE_R} ${RINK.CREASE_R} 0 0 0 ${M + RINK.GOAL_R} ${M + RINK.H/2 + RINK.CREASE_R}`}
        fill="rgba(29,78,216,0.15)" stroke="#dc2626" strokeWidth="0.25" />

      {/* Goals (rectangles behind the goal line) */}
      <rect x={M + RINK.GOAL_L - 2} y={M + RINK.H/2 - 3} width="2" height="6" fill="rgba(220,38,38,0.18)" stroke="#dc2626" strokeWidth="0.25" />
      <rect x={M + RINK.GOAL_R}     y={M + RINK.H/2 - 3} width="2" height="6" fill="rgba(220,38,38,0.18)" stroke="#dc2626" strokeWidth="0.25" />

      {/* Trapezoids behind each net (NHL goalie play-the-puck zones) */}
      <Trapezoid M={M} side="L" />
      <Trapezoid M={M} side="R" />
    </g>
  )
}

function Trapezoid({ M, side }) {
  // Behind-the-goal zone, narrows from goal-line out to the boards. NHL trap is
  // 11 ft wide at goal line, ~22 ft wide at the boards. The trapezoid lives
  // outside the goal line (i.e. between the goal line and the end boards).
  const yTop = RINK.H/2 - 11
  const yBot = RINK.H/2 + 11
  const wideTop = RINK.H/2 - 22
  const wideBot = RINK.H/2 + 22
  if (side === 'L') {
    return (
      <path d={`M ${M + RINK.GOAL_L} ${M + yTop} L ${M + 0} ${M + wideTop} L ${M + 0} ${M + wideBot} L ${M + RINK.GOAL_L} ${M + yBot}`}
        fill="none" stroke="#dc2626" strokeWidth="0.25" strokeDasharray="0.7 0.5" />
    )
  }
  return (
    <path d={`M ${M + RINK.GOAL_R} ${M + yTop} L ${M + RINK.W} ${M + wideTop} L ${M + RINK.W} ${M + wideBot} L ${M + RINK.GOAL_R} ${M + yBot}`}
      fill="none" stroke="#dc2626" strokeWidth="0.25" strokeDasharray="0.7 0.5" />
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Jersey chip — SVG version (on rink) and HTML version (in sidebar + ghost)
// ════════════════════════════════════════════════════════════════════════════
function JerseySvg({ player, colors, size }) {
  const s = size
  const r = s / 2
  const num = String(player.number || '').slice(0, 2)
  const ink = readableOn(colors.jerseyPrimary) // trim + number, auto-contrasted
  const fontSize = num.length >= 2 ? s * 0.38 : s * 0.5
  const isGoalie = (player.eligibility || []).includes('G')
  return (
    <g>
      {/* Gold rim hugging the jersey marks goalies. Drawn behind the jersey so
          only the rim outside it shows; inside the off-position warning ring
          (r 6.8 at size 11) so a goalie placed out of slot shows both, distinct. */}
      {isGoalie && (
        <circle cx="0" cy="0" r={r * 1.14} fill="none" stroke={GOALIE_GOLD} strokeWidth={s * 0.08} />
      )}
      <circle cx="0" cy="0" r={r} fill={colors.jerseyPrimary} stroke={ink} strokeWidth={s * 0.06} />
      <text x="0" y={fontSize * 0.36} textAnchor="middle" fill={ink} fontSize={fontSize} style={{ fontFamily: 'system-ui, -apple-system, sans-serif', fontWeight: 800, letterSpacing: 0 }}>
        {num}
      </text>
      {/* Handedness badge top-right */}
      <g transform={`translate(${r * 0.6},${-r * 0.7})`}>
        <circle r={s * 0.18} fill="#e2e8f0" stroke="rgba(0,0,0,0.35)" strokeWidth={s * 0.025} />
        <text y={s * 0.07} textAnchor="middle" fill="#0b1118" fontSize={s * 0.24} style={{ fontFamily: 'system-ui, sans-serif', fontWeight: 700 }}>
          {player.handedness}
        </text>
      </g>
      {/* Name plate below */}
      {player.name ? (
        <g pointerEvents="none">
          <rect x={-s * 0.9} y={r + s * 0.05} width={s * 1.8} height={s * 0.36} rx={s * 0.08} fill="rgba(11,17,24,0.85)" />
          <text x="0" y={r + s * 0.32} textAnchor="middle" fill="#fff" fontSize={s * 0.24} style={{ fontFamily: 'system-ui, sans-serif', fontWeight: 600 }}>
            {String(player.name).toUpperCase().slice(0, 12)}
          </text>
        </g>
      ) : null}
    </g>
  )
}

function JerseyChip({ player, colors, size = 44 }) {
  const fontSize = String(player.number || '').length >= 2 ? size * 0.38 : size * 0.5
  const ink = readableOn(colors.jerseyPrimary)
  const isGoalie = (player.eligibility || []).includes('G')
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: colors.jerseyPrimary,
      border: `${Math.max(2, size * 0.06)}px solid ${ink}`,
      color: ink,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize, fontWeight: 800, position: 'relative',
      // Gold ring marks goalies in roster lists + the picker (mirrors the rink rim).
      boxShadow: isGoalie
        ? `0 0 0 ${Math.max(2, size * 0.07)}px ${GOALIE_GOLD}, 0 2px 4px rgba(0,0,0,0.25)`
        : '0 2px 4px rgba(0,0,0,0.25)',
    }}>
      {player.number || ''}
      <div style={{
        position: 'absolute', top: -size * 0.08, right: -size * 0.08,
        width: size * 0.36, height: size * 0.36, borderRadius: '50%',
        background: '#e2e8f0', color: '#0b1118',
        fontSize: size * 0.22, fontWeight: 700, lineHeight: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: '1px solid rgba(0,0,0,0.35)',
      }}>{player.handedness}</div>
    </div>
  )
}

function drawJerseyCanvas(ctx, cx, cy, r, player, colors) {
  const ink = readableOn(colors.jerseyPrimary)
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = colors.jerseyPrimary
  ctx.fill()
  ctx.lineWidth = Math.max(1, r * 0.12)
  ctx.strokeStyle = ink
  ctx.stroke()

  // Goalie gold rim — must mirror JerseySvg's ring (r*1.14, width s*0.08 = r*0.16)
  // or the exported PNG won't match the on-screen rink.
  if ((player.eligibility || []).includes('G')) {
    ctx.beginPath()
    ctx.arc(cx, cy, r * 1.14, 0, Math.PI * 2)
    ctx.strokeStyle = GOALIE_GOLD
    ctx.lineWidth = Math.max(1, r * 0.16)
    ctx.stroke()
  }

  const num = String(player.number || '').slice(0, 2)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = ink
  const fs = num.length >= 2 ? r * 0.85 : r * 1.1
  ctx.font = `800 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
  ctx.fillText(num, cx, cy + 1)

  // Handedness badge
  const bx = cx + r * 0.6, by = cy - r * 0.7, br = r * 0.36
  ctx.beginPath()
  ctx.arc(bx, by, br, 0, Math.PI * 2)
  ctx.fillStyle = '#e2e8f0'
  ctx.fill()
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'
  ctx.lineWidth = Math.max(0.5, br * 0.12)
  ctx.stroke()
  ctx.fillStyle = '#0b1118'
  ctx.font = `700 ${br * 1.15}px system-ui, sans-serif`
  ctx.fillText(player.handedness, bx, by + 1)

  // Name plate
  if (player.name) {
    const w = r * 3.4, h = r * 0.85
    const x = cx - w / 2, y = cy + r + r * 0.15
    ctx.fillStyle = 'rgba(11,17,24,0.9)'
    roundRect(ctx, x, y, w, h, h * 0.25)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = `600 ${h * 0.62}px system-ui, sans-serif`
    ctx.fillText(String(player.name).toUpperCase().slice(0, 12), cx, y + h / 2 + 1)
  }
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// ════════════════════════════════════════════════════════════════════════════
// Sidebar — roster + line chart preview
// ════════════════════════════════════════════════════════════════════════════
function Sidebar({ mobile, innerRef, roster, lines, view, colors, hoverBench, dragPlayerId, onBeginDrag, onAddPlayer, onEditPlayer, playerById }) {
  const [tab, setTab] = useState('roster')
  // On phones the roster is a collapsible bottom sheet, collapsed by default so
  // the portrait rink uses nearly the full screen height (and is therefore much
  // wider — its width is height × the fixed rink aspect). Tapping a tab or the
  // handle expands it for roster editing. Desktop is always the full panel.
  const [collapsed, setCollapsed] = useState(true)
  const isCollapsed = mobile && collapsed
  const wrap = mobile
    ? { width: '100%', height: isCollapsed ? 'auto' : '50%', flexShrink: 0, borderTop: '1px solid #1f2937' }
    : { width: 340, borderLeft: '1px solid #1f2937' }
  return (
    <div ref={innerRef} className={mobile ? 'rr-mob-sidebar' : undefined} style={{
      ...wrap,
      background: hoverBench && dragPlayerId ? '#0e2030' : '#0b1118',
      transition: 'background 0.15s',
      display: 'flex', flexDirection: 'column', minHeight: 0,
    }}>
      <div style={{ display: 'flex', gap: 4, padding: 8, borderBottom: '1px solid #1f2937', alignItems: 'center' }}>
        {mobile && (
          <button onClick={() => setCollapsed(c => !c)} title={isCollapsed ? 'Show roster' : 'Hide roster'}
            style={{
              padding: '6px 10px', fontSize: 13, lineHeight: 1, fontWeight: 700,
              background: '#111b27', color: '#4cc2ff', border: '1px solid #1e3a8a',
              borderRadius: 6, cursor: 'pointer',
            }}>{isCollapsed ? '▴' : '▾'}</button>
        )}
        {['roster', 'lines'].map(t => (
          <button key={t} onClick={() => { setTab(t); if (mobile) setCollapsed(false) }}
            style={{
              flex: 1, padding: '6px 10px', fontSize: 12, fontWeight: 600, letterSpacing: 0.5,
              background: tab === t ? '#111b27' : 'transparent',
              color: tab === t ? '#fff' : '#94a3b8',
              border: '1px solid ' + (tab === t ? '#334155' : '#1f2937'),
              borderRadius: 6, cursor: 'pointer', textTransform: 'uppercase',
            }}>{t}</button>
        ))}
      </div>
      {!isCollapsed && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {tab === 'roster' ? (
            <RosterList roster={roster} colors={colors} onBeginDrag={onBeginDrag} onEditPlayer={onEditPlayer} onAddPlayer={onAddPlayer} dragPlayerId={dragPlayerId} />
          ) : (
            <LineChart lines={lines} view={view} playerById={playerById} colors={colors} />
          )}
        </div>
      )}
    </div>
  )
}

function RosterList({ roster, colors, onBeginDrag, onEditPlayer, onAddPlayer, dragPlayerId }) {
  return (
    <div style={{ padding: 8 }}>
      <button onClick={onAddPlayer}
        style={{
          width: '100%', padding: '10px 12px',
          background: '#0e2030', color: '#4cc2ff',
          border: '1px dashed #1e3a8a', borderRadius: 8, cursor: 'pointer',
          fontSize: 13, fontWeight: 600,
        }}>+ Add Player</button>
      {roster.length === 0 ? (
        <div style={{ color: '#475569', fontSize: 12, padding: '14px 8px', lineHeight: 1.5 }}>
          Your roster is empty. Add players to build lines, defensive pairs,
          power-play units, and a goalie depth chart.
        </div>
      ) : null}
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {roster.map(p => (
          <div key={p.id}
            onPointerDown={(e) => onBeginDrag(e, p.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '6px 8px',
              background: dragPlayerId === p.id ? '#111b27' : '#0e1722',
              border: '1px solid #1f2937', borderRadius: 8,
              cursor: 'grab', touchAction: 'none',
              opacity: dragPlayerId === p.id ? 0.5 : 1,
            }}>
            <JerseyChip player={p} colors={colors} size={38} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.name || <span style={{ color: '#64748b' }}>Unnamed</span>}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>
                #{p.number || '—'} · {p.eligibility.length ? p.eligibility.join('/') : 'No positions'}
              </div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); onEditPlayer(p.id) }}
              onPointerDown={(e) => e.stopPropagation()}
              style={{ padding: '4px 8px', fontSize: 11, background: 'transparent', color: '#94a3b8', border: '1px solid #1f2937', borderRadius: 5, cursor: 'pointer' }}>
              edit
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function LineChart({ lines, view, playerById, colors }) {
  const cellName = (id) => {
    const p = id ? playerById(id) : null
    if (!p) return <span style={{ color: '#475569' }}>—</span>
    return <span>{p.number ? `#${p.number} ` : ''}{p.name || 'Unnamed'}</span>
  }
  const Section = ({ title, children }) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: '#94a3b8', padding: '4px 8px', textTransform: 'uppercase' }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  )
  const row = (label, ids, isActive, goalie) => (
    <div key={label} style={{
      display: 'grid', gridTemplateColumns: '36px 1fr', gap: 8,
      padding: '4px 8px', fontSize: 12, color: '#cbd5e1',
      // Goalie rows read in gold (gold tint for the highlighted starter); line/pair
      // rows keep the cyan active highlight. Makes netminder coverage scannable.
      background: isActive ? (goalie ? 'rgba(245,197,66,0.12)' : '#0e2030') : 'transparent',
      borderLeft: goalie ? `2px solid ${GOALIE_GOLD}` : (isActive ? '2px solid #4cc2ff' : '2px solid transparent'),
    }}>
      <div style={{ fontWeight: 700, color: '#64748b' }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 8px' }}>
        {ids.map((id, i) => <div key={i} style={{ minWidth: 70 }}>{cellName(id)}</div>)}
      </div>
    </div>
  )
  return (
    <div style={{ padding: 4 }}>
      <Section title="Forwards">
        {lines.forwards.map((f, i) => row(`L${i + 1}`, [f.LW, f.C, f.RW], view.mode === 'ES' && view.selectedLine === i))}
      </Section>
      <Section title="Defense">
        {lines.defense.map((d, i) => row(`D${i + 1}`, [d.LD, d.RD], view.mode === 'ES' && view.selectedPair === i))}
      </Section>
      <Section title="Power Play">
        {lines.pp.map((u, i) => row(`PP${i + 1}`, u.slots, view.mode === 'PP' && view.selectedUnit === i))}
      </Section>
      <Section title="Penalty Kill">
        {lines.pk.map((u, i) => row(`PK${i + 1}`, u.slots, view.mode === 'PK' && view.selectedUnit === i))}
      </Section>
      <Section title="Goalies">
        {row('G1', [lines.goalies.starter], true, true)}
        {row('G2', [lines.goalies.backup], false, true)}
        {row('EBUG', [lines.goalies.emergency], false, true)}
      </Section>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Color popover (two-click: click target → pick swatch → applies)
// ════════════════════════════════════════════════════════════════════════════
function ColorPopover({ target, value, onPick, onClose }) {
  const swatches = SWATCHES
  const label = { jerseyPrimary: 'Jersey Color' }[target] || target
  return (
    <div onMouseDown={onClose} onTouchStart={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
      }}>
      <div onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}
        style={{
          ...GLASS_PANEL, borderRadius: 10,
          padding: 16, minWidth: 280, maxWidth: 360,
        }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontFamily: DISPLAY_FONT, fontSize: 15, fontWeight: 700, letterSpacing: 0.6, color: '#cbd5e1', textTransform: 'uppercase' }}>{label}</div>
          <div style={{ width: 22, height: 22, borderRadius: 4, background: value, border: '1px solid rgba(255,255,255,0.18)' }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
          {swatches.map(c => (
            <button key={c} onClick={() => onPick(c)}
              style={{
                aspectRatio: '1', background: c, border: c === value ? '2px solid #4cc2ff' : '1px solid rgba(255,255,255,0.18)',
                borderRadius: 6, cursor: 'pointer',
              }} />
          ))}
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// My Teams — named local saves (save current lineup, load / rename / delete)
// ════════════════════════════════════════════════════════════════════════════
function fmtWhen(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}
function TeamsModal({ teams, rosterCount, onSaveNew, onOverwrite, onLoad, onRename, onDelete, onClose }) {
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState(null) // team id being renamed
  const [renameVal, setRenameVal] = useState('')
  const btn = {
    padding: '6px 10px', fontSize: 12, fontWeight: 600,
    background: '#0b1118', color: '#cbd5e1', border: '1px solid #1f2937',
    borderRadius: 6, cursor: 'pointer',
  }
  return (
    <div onMouseDown={onClose} onTouchStart={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}>
      <div onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}
        style={{ ...GLASS_PANEL, borderRadius: 12, padding: 18, width: '100%', maxWidth: 440, maxHeight: '82vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: '#cbd5e1' }}>My Teams</div>
          <button onClick={onClose} style={{ ...btn, padding: '4px 8px' }}>✕</button>
        </div>

        {/* Save current lineup */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <input value={name} onChange={(e) => setName(e.target.value.slice(0, 40))}
            placeholder="Name this lineup…"
            onKeyDown={(e) => { if (e.key === 'Enter') { onSaveNew(name); setName('') } }}
            style={{ flex: 1, padding: '8px 10px', background: '#0b1118', color: '#e2e8f0', border: '1px solid #1f2937', borderRadius: 6, fontSize: 13 }} />
          <button onClick={() => { onSaveNew(name); setName('') }}
            style={{ padding: '8px 14px', background: '#0ea5e9', color: '#0b1118', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>
            Save current
          </button>
        </div>
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
          Saves a snapshot of the current roster &amp; lines ({rosterCount} player{rosterCount === 1 ? '' : 's'}) to this device.
        </div>

        {/* Saved teams list */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {teams.length === 0 ? (
            <div style={{ color: '#475569', fontSize: 12, padding: '10px 4px', lineHeight: 1.5 }}>
              No saved teams yet. Build a lineup, then save it above to keep more than one roster on this device.
            </div>
          ) : teams.map(t => (
            <div key={t.id} style={{ background: '#0e1722', border: '1px solid #1f2937', borderRadius: 8, padding: 10 }}>
              {renaming === t.id ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={renameVal} autoFocus onChange={(e) => setRenameVal(e.target.value.slice(0, 40))}
                    onKeyDown={(e) => { if (e.key === 'Enter') { onRename(t.id, renameVal); setRenaming(null) } }}
                    style={{ flex: 1, padding: '6px 8px', background: '#0b1118', color: '#e2e8f0', border: '1px solid #1f2937', borderRadius: 6, fontSize: 13 }} />
                  <button onClick={() => { onRename(t.id, renameVal); setRenaming(null) }} style={{ ...btn, color: '#4cc2ff' }}>Save</button>
                  <button onClick={() => setRenaming(null)} style={btn}>Cancel</button>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
                      <div style={{ fontSize: 10, color: '#64748b' }}>
                        {(t.state?.roster?.length ?? 0)} players · saved {fmtWhen(t.savedAt)}
                      </div>
                    </div>
                    <button onClick={() => onLoad(t.id)}
                      style={{ padding: '6px 14px', background: '#1e3a8a', color: '#fff', border: '1px solid #3b82f6', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                      Load
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => { if (window.confirm(`Overwrite "${t.name}" with the current lineup?`)) onOverwrite(t.id) }} style={btn}>Update</button>
                    <button onClick={() => { setRenaming(t.id); setRenameVal(t.name) }} style={btn}>Rename</button>
                    <div style={{ flex: 1 }} />
                    <button onClick={() => { if (window.confirm(`Delete "${t.name}"? This can't be undone.`)) onDelete(t.id) }}
                      style={{ ...btn, color: '#fca5a5', borderColor: '#7f1d1d' }}>Delete</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Action menu (fires when a rink chip is tapped — gives Edit / Remove / Cancel)
// ════════════════════════════════════════════════════════════════════════════
// Small floating name field anchored at the tap point on a rink slot. Enter or
// tapping away commits (so a typed name sticks without a confirm step); Escape
// or the backdrop on an untouched field cancels. For an existing chip it also
// offers Remove (clear the slot) and Details (full player modal).
function readViewport() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  const ih = typeof window !== 'undefined' ? window.innerHeight : 600
  const iw = typeof window !== 'undefined' ? window.innerWidth : 800
  if (!vv) return { offsetLeft: 0, offsetTop: 0, width: iw, height: ih, keyboard: 0 }
  return {
    offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop, width: vv.width, height: vv.height,
    keyboard: Math.max(0, ih - (vv.offsetTop + vv.height)),
  }
}

function InlineNameEditor({ initialName, slotLabel, isNew, onCommit, onRemove, onDetails, onCancel }) {
  const [val, setVal] = useState(initialName)
  const inputRef = useRef(null)
  const [vp, setVp] = useState(readViewport)
  useEffect(() => { const el = inputRef.current; if (el) { el.focus(); el.select() } }, [])
  // Track the visual viewport so the card follows the keyboard as it opens/closes.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const on = () => setVp(readViewport())
    vv.addEventListener('resize', on)
    vv.addEventListener('scroll', on)
    return () => { vv.removeEventListener('resize', on); vv.removeEventListener('scroll', on) }
  }, [])

  const W = 260
  // Centre horizontally in the visible viewport. With the soft keyboard open,
  // sit just above it; otherwise centre vertically. Identical logic on every
  // platform — driven purely by Visual Viewport metrics, no mobile/desktop fork.
  const centerLeft = vp.offsetLeft + vp.width / 2
  const kbdOpen = vp.keyboard > 100
  const pos = kbdOpen
    ? { left: centerLeft, bottom: vp.keyboard + 14, transform: 'translateX(-50%)' }
    : { left: centerLeft, top: vp.offsetTop + vp.height / 2, transform: 'translate(-50%, -50%)' }

  function commit() { onCommit(val) }
  function onKeyDown(e) {
    if (e.key === 'Enter') { e.preventDefault(); commit() }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
  }
  const btn = {
    flex: 1, padding: '7px 10px', fontSize: 12, fontWeight: 600,
    background: '#0b1118', color: '#94a3b8',
    border: '1px solid #1f2937', borderRadius: 6, cursor: 'pointer',
  }
  return (
    <div onMouseDown={onCancel} onTouchStart={onCancel}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 200 }}>
      <div onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}
        style={{
          position: 'fixed', ...pos, width: W,
          ...GLASS_PANEL, borderRadius: 10,
          padding: 10,
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: '#64748b', textTransform: 'uppercase' }}>
          {isNew ? `New player · ${slotLabel}` : `Name · ${slotLabel}`}
        </div>
        <input
          ref={inputRef}
          value={val}
          onChange={(e) => setVal(e.target.value.slice(0, 30))}
          onKeyDown={onKeyDown}
          placeholder="Player name"
          style={{ ...inputStyle, fontSize: 14 }}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={commit} style={{ ...btn, background: '#0ea5e9', color: '#0b1118', borderColor: '#0ea5e9', fontWeight: 700 }}>
            {isNew ? 'Add' : 'Save'}
          </button>
          {onDetails && <button onClick={onDetails} style={btn}>Details</button>}
          {onRemove && <button onClick={onRemove} style={{ ...btn, color: '#fca5a5', borderColor: '#7f1d1d' }}>Remove</button>}
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Player picker — tap a placed token (Edit mode) to choose who plays that spot.
// Eligible players are listed first; picking someone already on the rink swaps
// them in (handled by the caller). Also offers add-new / edit / remove.
// ════════════════════════════════════════════════════════════════════════════
function PlayerPicker({ slotLabel, slotDef, currentId, roster, colors, onPick, onNew, onEditCurrent, onRemove, onClose }) {
  const sorted = [...roster].sort((a, b) => {
    const ea = slotDef && isEligible(a, slotDef) ? 0 : 1
    const eb = slotDef && isEligible(b, slotDef) ? 0 : 1
    return ea - eb
  })
  const btn = {
    flex: 1, padding: '9px 10px', fontSize: 12, fontWeight: 700,
    background: '#0b1118', color: '#94a3b8', border: '1px solid #1f2937',
    borderRadius: 6, cursor: 'pointer',
  }
  return (
    <div onMouseDown={onClose} onTouchStart={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}>
      <div onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}
        style={{ ...GLASS_PANEL, borderRadius: 12, padding: 16, width: '100%', maxWidth: 380, maxHeight: '80vh', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontFamily: DISPLAY_FONT, fontSize: 16, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: '#cbd5e1' }}>
          Who plays {slotLabel}?
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sorted.length === 0 && (
            <div style={{ color: '#64748b', fontSize: 12, padding: '8px 4px' }}>No players in your roster yet — add one below.</div>
          )}
          {sorted.map(p => {
            const eligible = slotDef && isEligible(p, slotDef)
            const isCurrent = p.id === currentId
            return (
              <button key={p.id} onClick={() => onPick(p.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', textAlign: 'left',
                  background: isCurrent ? '#10233a' : '#0e1722',
                  border: '1px solid ' + (isCurrent ? '#1e3a8a' : '#1f2937'),
                  borderRadius: 8, cursor: 'pointer',
                }}>
                <JerseyChip player={p} colors={colors} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name || <span style={{ color: '#64748b' }}>Unnamed</span>}
                    {isCurrent && <span style={{ color: '#4cc2ff', fontSize: 10, fontWeight: 700, marginLeft: 6 }}>HERE NOW</span>}
                  </div>
                  <div style={{ fontSize: 11, color: eligible ? '#86efac' : '#94a3b8' }}>
                    #{p.number || '—'} · {p.eligibility.length ? p.eligibility.join('/') : 'No positions'}{eligible ? ' · fits' : ''}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onNew} style={{ ...btn, color: '#4cc2ff', borderColor: '#1e3a8a' }}>+ New</button>
          {currentId && <button onClick={onEditCurrent} style={btn}>Edit</button>}
          {currentId && <button onClick={onRemove} style={{ ...btn, color: '#fca5a5', borderColor: '#7f1d1d' }}>Remove</button>}
          <button onClick={onClose} style={btn}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Player edit modal
// ════════════════════════════════════════════════════════════════════════════
function PlayerModal({ player, onSave, onDelete, onClose }) {
  const [number, setNumber] = useState(player?.number || '')
  const [name, setName] = useState(player?.name || '')
  const [handedness, setHandedness] = useState(player?.handedness || 'R')
  const [eligibility, setEligibility] = useState(player?.eligibility || [])
  const [notes, setNotes] = useState(player?.notes || '')

  function toggle(p) {
    setEligibility(prev => prev.includes(p) ? prev.filter(x => x !== p) : prev.concat([p]))
  }
  function submit() {
    onSave({ number, name, handedness, eligibility, notes })
  }

  return (
    <div onMouseDown={onClose} onTouchStart={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
        padding: 16,
      }}>
      <div onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}
        style={{ ...GLASS_PANEL, borderRadius: 12, padding: 18, width: '100%', maxWidth: 380 }}>
        <div style={{ fontFamily: DISPLAY_FONT, fontSize: 16, fontWeight: 700, letterSpacing: 0.6, marginBottom: 12, textTransform: 'uppercase', color: '#cbd5e1' }}>
          {player ? 'Edit Player' : 'New Player'}
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          <Field label="Number">
            <input value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, '').slice(0, 2))}
              inputMode="numeric" style={inputStyle} placeholder="#" />
          </Field>
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value.slice(0, 30))} style={inputStyle} placeholder="Player name" autoFocus={!player} />
          </Field>
          <Field label="Shot">
            <div style={{ display: 'flex', gap: 6 }}>
              {['L', 'R'].map(h => (
                <button key={h} onClick={() => setHandedness(h)}
                  style={{
                    flex: 1, padding: '8px 10px', fontSize: 13, fontWeight: 700,
                    background: handedness === h ? '#1e3a8a' : '#0b1118',
                    color: handedness === h ? '#fff' : '#94a3b8',
                    border: '1px solid ' + (handedness === h ? '#3b82f6' : '#1f2937'),
                    borderRadius: 6, cursor: 'pointer',
                  }}>{h === 'L' ? 'Left' : 'Right'}</button>
              ))}
            </div>
          </Field>
          <Field label="Eligibility">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {POSITIONS.map(p => (
                <button key={p} onClick={() => toggle(p)}
                  style={{
                    padding: '6px 10px', fontSize: 12, fontWeight: 700,
                    background: eligibility.includes(p) ? '#0ea5e9' : '#0b1118',
                    color: eligibility.includes(p) ? '#0b1118' : '#94a3b8',
                    border: '1px solid ' + (eligibility.includes(p) ? '#0ea5e9' : '#1f2937'),
                    borderRadius: 999, cursor: 'pointer',
                  }}>{p}</button>
              ))}
            </div>
          </Field>
          <Field label="Notes">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 200))} style={{ ...inputStyle, minHeight: 56, resize: 'vertical' }}
              placeholder="Line chemistry, matchup tags…" />
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          {onDelete && (
            <button onClick={() => { if (window.confirm('Remove this player?')) onDelete() }}
              style={{ padding: '8px 12px', background: 'transparent', color: '#ef4444', border: '1px solid #7f1d1d', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={onClose}
            style={{ padding: '8px 14px', background: 'transparent', color: '#cbd5e1', border: '1px solid #1f2937', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
            Cancel
          </button>
          <button onClick={submit}
            style={{ padding: '8px 14px', background: '#0ea5e9', color: '#0b1118', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

const inputStyle = {
  width: '100%', padding: '8px 10px',
  background: '#0b1118', color: '#e2e8f0',
  border: '1px solid #1f2937', borderRadius: 6, fontSize: 13,
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: '#64748b', textTransform: 'uppercase' }}>{label}</span>
      {children}
    </label>
  )
}
