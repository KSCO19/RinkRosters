import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
  // Power Play (5 skaters, generic) -- 1-3-1 classic look
  PP: [
    { key: 'G',  label: 'G',  x: 12,  y: 42.5, pos: 'G' },
    { key: 'P1', label: 'PT', x: 130, y: 42.5, pos: 'SKATER' }, // QB / point
    { key: 'P2', label: 'LW', x: 158, y: 22,   pos: 'SKATER' }, // L half-wall
    { key: 'P3', label: 'BU', x: 165, y: 42.5, pos: 'SKATER' }, // bumper / slot
    { key: 'P4', label: 'RW', x: 158, y: 63,   pos: 'SKATER' }, // R half-wall
    { key: 'P5', label: 'NF', x: 180, y: 42.5, pos: 'SKATER' }, // net-front
  ],
  // Penalty Kill (4 skaters, generic) -- box in D-zone
  PK: [
    { key: 'G',  label: 'G',  x: 12, y: 42.5, pos: 'G' },
    { key: 'K1', label: 'F',  x: 35, y: 28,   pos: 'SKATER' },
    { key: 'K2', label: 'F',  x: 35, y: 57,   pos: 'SKATER' },
    { key: 'K3', label: 'D',  x: 18, y: 28,   pos: 'SKATER' },
    { key: 'K4', label: 'D',  x: 18, y: 57,   pos: 'SKATER' },
  ],
}

const FORMAT_KEYS = ['5v5', '4v4', '3v3']
const POSITIONS = ['C', 'LW', 'RW', 'LD', 'RD', 'G']
const POSITION_FAMILY = { C: 'F', LW: 'F', RW: 'F', LD: 'D', RD: 'D', G: 'G' }

const STORAGE_KEY = 'rinkrosters.v1'

// ─── Defaults ─────────────────────────────────────────────────────────────────
const DEFAULT_COLORS = {
  jerseyPrimary: '#1d4ed8',   // royal blue
  jerseySecondary: '#f8fafc', // trim white
  number: '#ffffff',
  ice: '#f4f9ff',
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
const ICE_SWATCHES = ['#f4f9ff', '#ffffff', '#e6f0fa', '#d6e6f5', '#fff8e6', '#f5f5f5']

// ════════════════════════════════════════════════════════════════════════════
// Main app
// ════════════════════════════════════════════════════════════════════════════
export default function RinkRostersApp() {
  const [state, setState] = useState(loadState)
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state; saveState(state) }, [state])

  // Drag is owned by refs (avoid re-rendering 60×/sec on pointermove); only
  // the lightweight dragGhost / hover state goes through React.
  const dragRef = useRef(null) // { source: {kind, ...}, playerId, startX, startY, moved }
  const [dragGhost, setDragGhost] = useState(null) // { playerId, x, y } in screen coords
  const [hoverSlot, setHoverSlot] = useState(null) // { unitKey, slotKey } or 'BENCH'

  const rinkRef = useRef(null)
  const rosterRef = useRef(null)
  const [pickerFor, setPickerFor] = useState(null) // 'jerseyPrimary' | 'jerseySecondary' | 'number' | 'ice' | null
  const [editPlayerId, setEditPlayerId] = useState(null) // open the edit modal for this player
  const [actionMenu, setActionMenu] = useState(null) // { source, playerId, x, y } — tap on a rink chip
  const [importErr, setImportErr] = useState('')
  const fileInputRef = useRef(null)

  const { roster, lines, view, colors, format } = state

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
  // Returns true if applied, false if ineligible.
  function assignToSlot(target, playerId) {
    const player = playerById(playerId)
    if (!player) return false
    const slot = resolveSlotDef(target)
    if (!slot) return false
    if (!isEligible(player, slot)) return false

    setState(s => {
      const lines = { ...s.lines }
      if (target.kind === 'ES_F') {
        lines.forwards = lines.forwards.map((f, i) => i === target.lineIdx ? { ...f, [target.role]: playerId } : f)
      } else if (target.kind === 'ES_D') {
        lines.defense = lines.defense.map((d, i) => i === target.pairIdx ? { ...d, [target.role]: playerId } : d)
      } else if (target.kind === 'PP') {
        lines.pp = lines.pp.map((u, i) => i === target.unitIdx ? { ...u, slots: u.slots.map((p, j) => j === target.slotIdx ? playerId : p) } : u)
      } else if (target.kind === 'PK') {
        lines.pk = lines.pk.map((u, i) => i === target.unitIdx ? { ...u, slots: u.slots.map((p, j) => j === target.slotIdx ? playerId : p) } : u)
      } else if (target.kind === 'G') {
        lines.goalies = { ...lines.goalies, [target.role]: playerId }
      }
      return { ...s, lines }
    })
    return true
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
  function beginDrag(e, sourceDesc, playerId) {
    if (!playerId) return
    e.preventDefault?.()
    const pt = pointerXY(e)
    dragRef.current = { source: sourceDesc, playerId, startX: pt.x, startY: pt.y, moved: false }
    setDragGhost({ playerId, x: pt.x, y: pt.y })
    window.addEventListener('pointermove', onDragMove, { passive: false })
    window.addEventListener('pointerup', onDragEnd, { passive: false })
    window.addEventListener('pointercancel', onDragEnd, { passive: false })
    // Some Android browsers fire touchmove faster than pointermove; back it up.
    window.addEventListener('touchmove', preventDefault, { passive: false })
  }
  function onDragMove(e) {
    const d = dragRef.current
    if (!d) return
    e.preventDefault?.()
    const pt = pointerXY(e)
    const dx = Math.abs(pt.x - d.startX), dy = Math.abs(pt.y - d.startY)
    if (!d.moved && (dx > 3 || dy > 3)) d.moved = true
    setDragGhost(g => g ? { ...g, x: pt.x, y: pt.y } : g)
    setHoverSlot(detectHover(pt))
  }
  function onDragEnd(e) {
    const d = dragRef.current
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragEnd)
    window.removeEventListener('pointercancel', onDragEnd)
    window.removeEventListener('touchmove', preventDefault)
    if (!d) { setDragGhost(null); setHoverSlot(null); return }
    const pt = pointerXY(e)
    const hover = detectHover(pt)
    dragRef.current = null
    setDragGhost(null)
    setHoverSlot(null)

    // Tap (no movement) on a bench player opens the edit modal; on a rink
    // chip it opens a small action menu (Edit / Remove / Cancel). Drag
    // (moved) commits the drop and is handled below.
    if (!d.moved) {
      if (d.source.kind === 'BENCH') setEditPlayerId(d.playerId)
      else setActionMenu({ source: d.source, playerId: d.playerId, x: pt.x, y: pt.y })
      return
    }

    if (hover === 'BENCH') {
      // Drop back to bench: clear the source slot if we came from the rink.
      if (d.source.kind !== 'BENCH') clearSlot(d.source)
      return
    }
    if (hover && typeof hover === 'object' && hover.kind === 'RINK_SLOT') {
      const target = rinkSlotToTarget(hover.slotKey)
      if (!target) return
      const ok = assignToSlot(target, d.playerId)
      if (ok && d.source.kind !== 'BENCH') {
        // Slot-to-slot move: empty out the source (no swap — same player can
        // legitimately occupy both ES and a special-teams slot).
        const sameTarget = sameSlot(d.source, target)
        if (!sameTarget) clearSlot(d.source)
      }
    }
  }
  function detectHover(pt) {
    // Hit-test the rink slots first (more specific), then the bench drop zone.
    const rink = rinkRef.current
    if (rink) {
      const r = rink.getBoundingClientRect()
      if (pt.x >= r.left && pt.x <= r.right && pt.y >= r.top && pt.y <= r.bottom) {
        // Map screen→rink coordinates and find the nearest slot center.
        const x = ((pt.x - r.left) / r.width) * RINK.W
        const y = ((pt.y - r.top) / r.height) * RINK.H
        let best = null, bestD = Infinity
        for (const s of activeUnit.slots) {
          const dx = s.x - x, dy = s.y - y
          const d2 = dx*dx + dy*dy
          if (d2 < bestD) { bestD = d2; best = s }
        }
        // Generous catch radius (12 ft) so coaches don't have to be pixel-perfect.
        if (best && bestD < 12 * 12) return { kind: 'RINK_SLOT', slotKey: best.key }
        return null
      }
    }
    const roster = rosterRef.current
    if (roster) {
      const r = roster.getBoundingClientRect()
      if (pt.x >= r.left && pt.x <= r.right && pt.y >= r.top && pt.y <= r.bottom) return 'BENCH'
    }
    return null
  }

  function sameSlot(a, b) {
    if (!a || !b || a.kind !== b.kind) return false
    if (a.kind === 'ES_F') return a.lineIdx === b.lineIdx && a.role === b.role
    if (a.kind === 'ES_D') return a.pairIdx === b.pairIdx && a.role === b.role
    if (a.kind === 'PP' || a.kind === 'PK') return a.unitIdx === b.unitIdx && a.slotIdx === b.slotIdx
    if (a.kind === 'G') return a.role === b.role
    return false
  }

  // ── JSON import/export ──────────────────────────────────────────────────
  function exportJson() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'rinkrosters-roster.json'
    a.click()
    URL.revokeObjectURL(url)
  }
  function importJsonText(text) {
    try {
      const parsed = JSON.parse(text)
      setState(mergeStateShape(parsed))
      setImportErr('')
    } catch (e) {
      setImportErr('Invalid JSON file.')
    }
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

    const bbox = svg.getBoundingClientRect()
    const SCALE = 2
    const PW = Math.round(bbox.width * SCALE)
    const PH = Math.round(bbox.height * SCALE)
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
      const CW = PW + PAD * 2
      const CH = HDR + PH + FTR + PAD * 2

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

      // Rink
      ctx.drawImage(img, PAD, PAD + HDR, PW, PH)
      URL.revokeObjectURL(url)

      // Player chips overlaid programmatically (more reliable than SVG text).
      const sx = PW / RINK.W, sy = PH / RINK.H
      for (const s of activeUnit.slots) {
        const pid = activeUnit.filled[s.key]
        const p = pid ? playerById(pid) : null
        if (!p) continue
        const cx = PAD + s.x * sx
        const cy = PAD + HDR + s.y * sy
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
  const screen = useScreen()
  const mobile = screen.width < 880

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
          onExportJson={exportJson}
          onImportClick={() => fileInputRef.current?.click()}
          onPickColor={setPickerFor}
          colors={colors}
        />
        <LineSelector view={view} lines={lines} onView={(patch) => setState(s => ({ ...s, view: { ...s.view, ...patch } }))} />
        <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', alignItems: 'stretch', justifyContent: 'center' }}>
          <Rink
            innerRef={rinkRef}
            slots={activeUnit.slots}
            filled={activeUnit.filled}
            playerById={playerById}
            colors={colors}
            hoverSlot={hoverSlot && hoverSlot.kind === 'RINK_SLOT' ? hoverSlot.slotKey : null}
            dragPlayerId={dragRef.current?.playerId || null}
            isDragEligible={(slotKey) => {
              const d = dragRef.current
              if (!d) return null
              const slot = activeUnit.slots.find(s => s.key === slotKey)
              return slot ? isEligible(playerById(d.playerId), slot) : null
            }}
            onSlotPointerDown={(e, slotKey) => {
              const pid = activeUnit.filled[slotKey]
              if (!pid) return
              const target = rinkSlotToTarget(slotKey)
              if (!target) return
              beginDrag(e, target, pid)
            }}
          />
        </div>
        <input
          ref={fileInputRef} type="file" accept="application/json" style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (!f) return
            f.text().then(importJsonText).finally(() => { e.target.value = '' })
          }}
        />
        {importErr ? <div style={{ position: 'absolute', bottom: 12, left: 12, background: '#7f1d1d', color: '#fff', padding: '6px 10px', borderRadius: 6, fontSize: 12 }}>{importErr}</div> : null}
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
        dragPlayerId={dragRef.current?.playerId || null}
        onBeginDrag={(e, pid) => beginDrag(e, { kind: 'BENCH' }, pid)}
        onAddPlayer={() => setEditPlayerId('NEW')}
        onEditPlayer={(id) => setEditPlayerId(id)}
        playerById={playerById}
      />

      {/* Drag ghost (follows pointer) */}
      {dragGhost && (() => {
        const p = playerById(dragGhost.playerId)
        if (!p) return null
        return (
          <div style={{ position: 'fixed', left: dragGhost.x - 24, top: dragGhost.y - 24, width: 48, height: 48, pointerEvents: 'none', zIndex: 100, opacity: 0.92 }}>
            <JerseyChip player={p} colors={colors} size={48} />
          </div>
        )
      })()}

      {/* Color popover */}
      {pickerFor && (
        <ColorPopover
          target={pickerFor}
          value={colors[pickerFor]}
          onPick={(c) => { setColor(pickerFor, c); setPickerFor(null) }}
          onClose={() => setPickerFor(null)}
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

      {/* Rink-chip action menu */}
      {actionMenu && (() => {
        const p = playerById(actionMenu.playerId)
        if (!p) return null
        return (
          <ActionMenu
            player={p}
            colors={colors}
            x={actionMenu.x}
            y={actionMenu.y}
            onEdit={() => { setEditPlayerId(actionMenu.playerId); setActionMenu(null) }}
            onRemove={() => { clearSlot(actionMenu.source); setActionMenu(null) }}
            onClose={() => setActionMenu(null)}
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
function Header({ view, format, onView, onFormat, onExportPng, onExportJson, onImportClick, onPickColor, colors }) {
  const tabBtn = (label, mode) => (
    <button onClick={() => onView({ mode })}
      style={{
        padding: '8px 14px',
        background: view.mode === mode ? '#1e3a8a' : 'transparent',
        color: view.mode === mode ? '#fff' : '#94a3b8',
        border: '1px solid ' + (view.mode === mode ? '#3b82f6' : '#1f2937'),
        borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600, letterSpacing: 0.5,
      }}>{label}</button>
  )
  const btn = {
    padding: '6px 10px', background: '#111b27', color: '#cbd5e1', border: '1px solid #1f2937',
    borderRadius: 6, cursor: 'pointer', fontSize: 12,
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid #1f2937', flexWrap: 'wrap' }}>
      <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: 0.5, marginRight: 8 }}>
        <span style={{ color: '#4cc2ff' }}>RINK</span>ROSTERS
      </div>
      {tabBtn('Even Str', 'ES')}
      {tabBtn('Power Play', 'PP')}
      {tabBtn('Penalty Kill', 'PK')}
      {view.mode === 'ES' && (
        <select value={format} onChange={(e) => onFormat(e.target.value)}
          style={{ ...btn, background: '#0b1118', padding: '7px 10px' }}>
          {FORMAT_KEYS.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
      )}
      <div style={{ flex: 1 }} />
      <ColorChip label="Jersey" value={colors.jerseyPrimary} onClick={() => onPickColor('jerseyPrimary')} />
      <ColorChip label="Trim"   value={colors.jerseySecondary} onClick={() => onPickColor('jerseySecondary')} />
      <ColorChip label="Number" value={colors.number} onClick={() => onPickColor('number')} />
      <ColorChip label="Ice"    value={colors.ice} onClick={() => onPickColor('ice')} />
      <button onClick={onExportPng} style={btn}>PNG</button>
      <button onClick={onExportJson} style={btn}>Save</button>
      <button onClick={onImportClick} style={btn}>Load</button>
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
    <div style={{ display: 'flex', gap: 16, padding: '8px 12px', borderBottom: '1px solid #1f2937', flexWrap: 'wrap', fontSize: 12, color: '#94a3b8', alignItems: 'center' }}>
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
function Rink({ innerRef, slots, filled, playerById, colors, hoverSlot, dragPlayerId, isDragEligible, onSlotPointerDown }) {
  // viewBox uses a small margin around the rink so corner radius and the
  // boards' stroke have somewhere to live. The aspect ratio is preserved
  // (rink is 200×85 ft, ~2.35:1) and the SVG fills the container.
  const M = 4
  const VB_W = RINK.W + M * 2
  const VB_H = RINK.H + M * 2
  return (
    <svg
      ref={innerRef}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', height: '100%', userSelect: 'none', touchAction: 'none' }}
    >
      {/* Boards / ice surface */}
      <RinkBoards ice={colors.ice} M={M} />
      {/* Lines, dots, circles, creases, trapezoids — all NHL-correct */}
      <RinkMarkings M={M} />

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

      {/* Empty slot labels (subtle, only when slot is empty) */}
      {slots.map(s => filled[s.key] ? null : (
        <g key={'lbl-' + s.key} pointerEvents="none">
          <circle cx={s.x + M} cy={s.y + M} r="5" fill="none" stroke="rgba(11,17,24,0.35)" strokeWidth="0.3" strokeDasharray="1 0.6" />
          <text x={s.x + M} y={s.y + M + 1.4} textAnchor="middle" fontSize="3.2" fill="rgba(11,17,24,0.55)" style={{ fontFamily: 'system-ui, -apple-system, sans-serif', fontWeight: 700 }}>
            {s.label}
          </text>
        </g>
      ))}

      {/* Player chips */}
      {slots.map(s => {
        const pid = filled[s.key]
        if (!pid) return null
        const p = playerById(pid)
        if (!p) return null
        return (
          <g key={'chip-' + s.key}
            transform={`translate(${s.x + M},${s.y + M})`}
            style={{ cursor: 'grab' }}
            onPointerDown={(e) => onSlotPointerDown(e, s.key)}
          >
            <JerseySvg player={p} colors={colors} size={11} />
          </g>
        )
      })}
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

function RinkMarkings({ M }) {
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

      {/* Center faceoff circle + dot */}
      <circle cx={M + RINK.RED} cy={M + RINK.H/2} r={RINK.FACEOFF_R} fill="none" stroke={blue} strokeWidth="0.35" />
      <circle cx={M + RINK.RED} cy={M + RINK.H/2} r="0.8" fill={blue} />

      {/* Zone faceoff circles (4) + dots */}
      {[
        [RINK.ZONE_DOT_X_L, RINK.DOT_Y_T],
        [RINK.ZONE_DOT_X_L, RINK.DOT_Y_B],
        [RINK.ZONE_DOT_X_R, RINK.DOT_Y_T],
        [RINK.ZONE_DOT_X_R, RINK.DOT_Y_B],
      ].map(([x, y], i) => (
        <g key={i}>
          <circle cx={M + x} cy={M + y} r={RINK.FACEOFF_R} fill="none" stroke={red} strokeWidth="0.35" />
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
  const numColor = colors.number
  const fontSize = num.length >= 2 ? s * 0.38 : s * 0.5
  return (
    <g>
      <circle cx="0" cy="0" r={r} fill={colors.jerseyPrimary} stroke={colors.jerseySecondary} strokeWidth={s * 0.07} />
      <text x="0" y={fontSize * 0.36} textAnchor="middle" fill={numColor} fontSize={fontSize} style={{ fontFamily: 'system-ui, -apple-system, sans-serif', fontWeight: 800, letterSpacing: 0 }}>
        {num}
      </text>
      {/* Handedness badge top-right */}
      <g transform={`translate(${r * 0.6},${-r * 0.7})`}>
        <circle r={s * 0.18} fill={colors.jerseySecondary} stroke="rgba(0,0,0,0.35)" strokeWidth={s * 0.025} />
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
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: colors.jerseyPrimary,
      border: `${Math.max(2, size * 0.07)}px solid ${colors.jerseySecondary}`,
      color: colors.number,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize, fontWeight: 800, position: 'relative',
      boxShadow: '0 2px 4px rgba(0,0,0,0.25)',
    }}>
      {player.number || ''}
      <div style={{
        position: 'absolute', top: -size * 0.08, right: -size * 0.08,
        width: size * 0.36, height: size * 0.36, borderRadius: '50%',
        background: colors.jerseySecondary, color: '#0b1118',
        fontSize: size * 0.22, fontWeight: 700, lineHeight: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: '1px solid rgba(0,0,0,0.35)',
      }}>{player.handedness}</div>
    </div>
  )
}

function drawJerseyCanvas(ctx, cx, cy, r, player, colors) {
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = colors.jerseyPrimary
  ctx.fill()
  ctx.lineWidth = Math.max(1, r * 0.14)
  ctx.strokeStyle = colors.jerseySecondary
  ctx.stroke()

  const num = String(player.number || '').slice(0, 2)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = colors.number
  const fs = num.length >= 2 ? r * 0.85 : r * 1.1
  ctx.font = `800 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
  ctx.fillText(num, cx, cy + 1)

  // Handedness badge
  const bx = cx + r * 0.6, by = cy - r * 0.7, br = r * 0.36
  ctx.beginPath()
  ctx.arc(bx, by, br, 0, Math.PI * 2)
  ctx.fillStyle = colors.jerseySecondary
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
  const wrap = mobile
    ? { width: '100%', height: '40%', borderTop: '1px solid #1f2937' }
    : { width: 340, borderLeft: '1px solid #1f2937' }
  return (
    <div ref={innerRef} style={{
      ...wrap,
      background: hoverBench && dragPlayerId ? '#0e2030' : '#0b1118',
      transition: 'background 0.15s',
      display: 'flex', flexDirection: 'column', minHeight: 0,
    }}>
      <div style={{ display: 'flex', gap: 4, padding: 8, borderBottom: '1px solid #1f2937' }}>
        {['roster', 'lines'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              flex: 1, padding: '6px 10px', fontSize: 12, fontWeight: 600, letterSpacing: 0.5,
              background: tab === t ? '#111b27' : 'transparent',
              color: tab === t ? '#fff' : '#94a3b8',
              border: '1px solid ' + (tab === t ? '#334155' : '#1f2937'),
              borderRadius: 6, cursor: 'pointer', textTransform: 'uppercase',
            }}>{t}</button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'roster' ? (
          <RosterList roster={roster} colors={colors} onBeginDrag={onBeginDrag} onEditPlayer={onEditPlayer} onAddPlayer={onAddPlayer} dragPlayerId={dragPlayerId} />
        ) : (
          <LineChart lines={lines} view={view} playerById={playerById} colors={colors} />
        )}
      </div>
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
  const row = (label, ids, isActive) => (
    <div key={label} style={{
      display: 'grid', gridTemplateColumns: '36px 1fr', gap: 8,
      padding: '4px 8px', fontSize: 12, color: '#cbd5e1',
      background: isActive ? '#0e2030' : 'transparent',
      borderLeft: isActive ? '2px solid #4cc2ff' : '2px solid transparent',
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
        {row('G1', [lines.goalies.starter], true)}
        {row('G2', [lines.goalies.backup], false)}
        {row('EBUG', [lines.goalies.emergency], false)}
      </Section>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Color popover (two-click: click target → pick swatch → applies)
// ════════════════════════════════════════════════════════════════════════════
function ColorPopover({ target, value, onPick, onClose }) {
  const isIce = target === 'ice'
  const swatches = isIce ? ICE_SWATCHES : SWATCHES
  const label = {
    jerseyPrimary: 'Jersey Primary',
    jerseySecondary: 'Jersey Trim',
    number: 'Number',
    ice: 'Ice Tint',
  }[target] || target
  return (
    <div onMouseDown={onClose} onTouchStart={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
      }}>
      <div onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}
        style={{
          background: '#0e1722', border: '1px solid #1f2937', borderRadius: 10,
          padding: 16, minWidth: 280, maxWidth: 360,
          boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
        }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.5, color: '#cbd5e1', textTransform: 'uppercase' }}>{label}</div>
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
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>Custom</span>
          <input type="color" value={value} onChange={(e) => onPick(e.target.value)}
            style={{ width: 36, height: 28, border: 'none', background: 'transparent', cursor: 'pointer' }} />
          <input type="text" value={value} onChange={(e) => onPick(e.target.value)}
            style={{ flex: 1, padding: '4px 6px', background: '#0b1118', color: '#cbd5e1', border: '1px solid #1f2937', borderRadius: 4, fontSize: 12 }} />
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Action menu (fires when a rink chip is tapped — gives Edit / Remove / Cancel)
// ════════════════════════════════════════════════════════════════════════════
function ActionMenu({ player, colors, x, y, onEdit, onRemove, onClose }) {
  const W = 200, H = 168, GAP = 14
  const left = Math.max(8, Math.min((typeof window !== 'undefined' ? window.innerWidth : 800) - W - 8, x - W / 2))
  const top  = Math.max(8, Math.min((typeof window !== 'undefined' ? window.innerHeight : 600) - H - 8, y + GAP))
  const btn = {
    width: '100%', padding: '10px 12px', textAlign: 'left',
    background: '#0b1118', color: '#e2e8f0',
    border: '1px solid #1f2937', borderRadius: 6,
    fontSize: 13, fontWeight: 600, cursor: 'pointer',
  }
  return (
    <div onMouseDown={onClose} onTouchStart={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 200 }}>
      <div onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', left, top, width: W,
          background: '#0e1722', border: '1px solid #1f2937', borderRadius: 10,
          padding: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 4px 6px', borderBottom: '1px solid #1f2937', marginBottom: 4 }}>
          <JerseyChip player={player} colors={colors} size={32} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {player.name || 'Unnamed'}
            </div>
            <div style={{ fontSize: 10, color: '#94a3b8' }}>
              #{player.number || '—'} · {player.handedness}
            </div>
          </div>
        </div>
        <button onClick={onEdit} style={btn}>Edit player</button>
        <button onClick={onRemove} style={{ ...btn, color: '#fca5a5', borderColor: '#7f1d1d' }}>Remove from slot</button>
        <button onClick={onClose} style={{ ...btn, color: '#94a3b8' }}>Cancel</button>
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
        style={{ background: '#0e1722', border: '1px solid #1f2937', borderRadius: 12, padding: 18, width: '100%', maxWidth: 380 }}>
        <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.5, marginBottom: 12, textTransform: 'uppercase', color: '#cbd5e1' }}>
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
