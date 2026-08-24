// Serializer — Team E serializer (Layer 3).
//
// New export path: NIR -> Circuit JSON (typed via circuit-json) -> SVG render.
//
// HARD CONSTRAINT — no tscircuit wasm / tsci CLI on this path:
//   This module imports ONLY:
//     - circuit-json            (TypeScript type defs for Circuit JSON)
//     - circuit-to-svg          (renders Circuit JSON to SVG directly)
//     - @tscircuit/eval         (CircuitRunner for in-process layout + routing)
//   It OPTIONALLY lazy-imports `@tscircuit/schematic-viewer` if installed;
//   if that package is missing, it silently falls back to circuit-to-svg.
//   It NEVER calls `tsci simulate`, `@tscircuit/ngspice-spice-engine`, or
//   any wasm-based simulation wrapper.  This file performs ZERO simulation.
//
// The pre-existing TSX + `tsci build` CLI export path (index.circuit.tsx at
// project root) is untouched and remains the fallback for now.
//
// Supported NIR schemas:
//   - "v0.1-libbrecht"         Libbrecht-Hall fixture (legacy schema with
//                              top-level `circuit_json` carrying the old
//                              source_component_base / source_net shape)
//   - "v1.1-instrumentation"    Newer schema with top-level `components` /
//                              `netlist` / `board_spec` / etc.
//
// LOUD-FAILURE INVARIANT:
//   A NIR file whose schema we cannot positively identify raises an Error.
//   A NIR v1.1 file missing any required field raises an Error.
//   We NEVER silently return a [] or partial Circuit JSON — that was the bug
//   that motivated this rewrite.

import type { AnyCircuitElement } from "circuit-json"
import {
  convertCircuitJsonToPcbSvg,
  convertCircuitJsonToSchematicSvg,
} from "circuit-to-svg"
import type {
  Nir,
  NirCircuitJson,
  NirV11Component,
  NirV11NetlistEntry,
  NirV11BoardSpec,
  NirV11PlacementConstraint,
  NirV11FootprintPad,
  NirV11,
} from "./fixtures"
import { circuitJsonToKicadPcb } from "./kicadPcbWriter"
import {
  chamferCircuitJsonTracesTo45Degree,
  centerPcbLayout,
  enforceTracePadClearance,
  mergeCollinearSegments,
  removeZeroLengthSegments,
} from "./pcbRouting"
import { lookupSymbol, getGroundSymbolName, logMissingSymbol } from "./symbolLibrary"
import { lookupKicadSymbol, hasKicadSymbol, setUseKicadSymbols } from "./kicadSymbolLibrary"
import { getParsedFootprintSize, setUseParsedFootprints } from "./kicadFootprintLoader"

// --------------------------------------------------------------------------- //
// Env-flag wiring — gate KiCad library paths behind env vars
// --------------------------------------------------------------------------- //

if (process.env.KICAD_USE_SYMBOLS) {
  setUseKicadSymbols(true)
}
if (process.env.KICAD_USE_PARSED_FOOTPRINTS) {
  setUseParsedFootprints(true)
}

// --------------------------------------------------------------------------- //
// Types
// --------------------------------------------------------------------------- //

export type ViewerUsed =
  | "circuit-to-svg"
  | "@tscircuit/schematic-viewer"

export interface SerializerOutput {
  /** Circuit JSON elements (typed) extracted from the NIR input. */
  circuitJson: AnyCircuitElement[]
  /** Rendered SVG string. */
  svg: string
  /** Which renderer produced `svg`.  `null` means render was skipped. */
  viewerUsed: ViewerUsed | null
  /** KiCad .kicad_pcb S-expression text (async path only). */
  kicadPcb?: string
}

export type NirSchemaVersion = "v0.1-libbrecht" | "v1.1-instrumentation"

// --------------------------------------------------------------------------- //
// NIR -> Circuit JSON  (dispatched by version)
// --------------------------------------------------------------------------- //

// Synchronous entry point for v0.1 (libbrecht-hall) - stays sync for backward compat
export function nirToCircuitJsonSync(nir: Nir | unknown): AnyCircuitElement[] {
  const version = detectNirSchemaVersion(nir)
  return version === "v0.1-libbrecht"
    ? parseNirV01(nir as Nir)
    : parseNirV11Sync(nir as unknown as NirV11)  // fallback sync path
}

// Async entry point for v1.1 - uses tscircuit for auto-place + auto-route
export async function nirToCircuitJson(nir: Nir | unknown): Promise<AnyCircuitElement[]> {
  const version = detectNirSchemaVersion(nir)
  if (version === "v0.1-libbrecht") {
    return parseNirV01(nir as Nir)
  }
  // v1.1: use async tscircuit path for auto-place + auto-route
  return parseNirV11WithTscircuit(nir as unknown as NirV11)
}

// --------------------------------------------------------------------------- //
// v0.1 parser  — verbatim legacy path, untouched for backward compat
// --------------------------------------------------------------------------- //

/**
 * Parse the original Libbrecht-Hall-shaped NIR.
 *
 * This function body is preserved byte-for-byte from the previous
 * implementation (`nirToCircuitJson` pre-rewrite) so the Libbrecht-Hall
 * fixture continues to produce exactly the Circuit JSON it did before.
 * Any change to this branch breaks the "don't break backward compat" rule.
 */
function parseNirV01(nir: Nir): AnyCircuitElement[] {
  const out: AnyCircuitElement[] = []
  const cj: NirCircuitJson = nir.circuit_json ?? { components: [] }

  for (const comp of cj.components ?? []) {
    out.push({
      type: "source_component_base",
      source_component_id: `${comp.name}_source`,
      name: comp.name,
      ...normalizeComponentFields(comp),
    } as AnyCircuitElement)
  }

  for (const net of cj.nets ?? []) {
    out.push({
      type: "source_net",
      source_net_id: `net_${net.name}`,
      name: net.name,
      member_source_group_ids: [],
      is_power: Boolean(net.isPowerNet),
      is_ground: Boolean(net.isGroundNet),
    } as AnyCircuitElement)
  }

  for (const t of cj.traces ?? []) {
    out.push({
      type: "source_trace",
      source_trace_id: `trace_${t.from}_${t.to}`,
      connected_source_port_ids: [t.from, t.to],
      connected_source_net_ids: [],
    } as AnyCircuitElement)
  }

  return out
}

function normalizeComponentFields(
  comp: Record<string, unknown>,
): Record<string, unknown> {
  const { name, type, flagged, ...rest } = comp as {
    name: string
    type: string
    flagged?: boolean
    [k: string]: unknown
  }
  void name
  void type
  void flagged
  return rest
}

// --------------------------------------------------------------------------- //
// v1.1 parser  — NEW: tscircuit JSX -> CircuitRunner -> Circuit JSON
// --------------------------------------------------------------------------- //

/**
 * Parse the NIR v1.1 ("instrumentation_amp") schema by generating tscircuit JSX
 * and running it through CircuitRunner for auto-placement + autorouting.
 *
 * This replaces the previous custom union-find grid + manual orthogonal wire
 * drawing.  tscircuit's own layout solver and autorouter now handle placement
 * and trace routing.
 *
 * Flow:
 *   1. Validate required NIR v1.1 fields (loud failure on missing data)
 *   2. Generate a single tscircuit JSX file as a string (board + components + nets)
 *   3. Run it through CircuitRunner.executeWithFsMap -> renderUntilSettled
 *   4. getCircuitJson() -> AnyCircuitElement[] (includes pcb_component,
 *      schematic_component, source_trace, source_net, pcb_board, etc.)
 *   5. Return that array — downstream renderCircuitJson handles SVG as before
 */
async function parseNirV11WithTscircuit(nir: NirV11): Promise<AnyCircuitElement[]> {
  // 1. Validate required top-level fields
  requireKeys(nir, ["schema_version", "design_id", "components", "netlist", "board_spec"], "NIR v1.1 root")
  if (nir.schema_version !== "1.1" && nir.schema_version !== "1.2") {
    throw new Error(`NIR v1.1/v1.2 parser expects schema_version "1.1" or "1.2", got "${nir.schema_version}"`)
  }

  const comps = nir.components
  if (comps.length === 0) {
    throw new Error("NIR v1.1 `components` array is empty — refusing to emit empty Circuit JSON.")
  }

  // 2. Generate tscircuit JSX
  const jsx = generateTscircuitJsx(nir)

  // 3. Run through CircuitRunner
  const circuitJson = await runTscircuit({ "circuit.tsx": jsx })

  // CircuitRunner's internal autorouter can hit a case (confirmed: board
  // area too small/dense for its placement+routing to find ANY legal path)
  // where it swallows an internal AutorouterError and returns circuitJson
  // with pcb_trace elements present but every route empty — a silently
  // truncated/broken .kicad_pcb instead of a clear failure. Detect that
  // specific signature and fail loudly with actionable numbers instead.
  assertRoutingCompleted(circuitJson, nir)

  // 4. Restore original NIR net names (sanitization was prop-only)
  return restoreOriginalNetNames(circuitJson, nir.netlist)
}

// Detects total routing failure: pcb_trace elements exist (the netlist
// required routing) but every single one has an empty route. Confirmed
// root cause (2026-08-24 investigation): CircuitRunner's internal
// "capacity-mesh-autorouting" effect can hit a deterministic "static
// reachability precheck failed" (or, less predictably, a "ran out of
// iterations") AutorouterError for a board that's too small/dense for its
// placement to leave any legal routing path — and it swallows that error
// internally rather than surfacing it, so the caller just sees an
// otherwise-normal circuitJson with hollowed-out traces. Board area, not
// aspect ratio, was the reproduced driver: 3570mm^2 (both the real
// astracomputer board's 42x85mm shape and an equal-area 69x52mm rescale of
// the working default) failed outright, while ~4290-4800mm^2 routed
// successfully or nearly so, for the same 127-component/184-net fixture.
export function assertRoutingCompleted(circuitJson: AnyCircuitElement[], nir: NirV11): void {
  const netsNeedingRouting = nir.netlist.filter((n) => n.connections.length >= 2)
  if (netsNeedingRouting.length === 0) return

  // NOTE: do NOT early-return on `traces.length === 0`. Confirmed
  // (2026-08-25): when CircuitRunner's internal autorouter fails outright,
  // it can produce ZERO pcb_trace elements at all — not pcb_trace elements
  // with empty routes as originally assumed. Since netsNeedingRouting is
  // already nonzero at this point, an empty traces array here is itself
  // the failure signature, not evidence that nothing needed routing.
  const traces = circuitJson.filter((e: any) => e.type === "pcb_trace") as any[]
  const routedTraces = traces.filter((t: any) => Array.isArray(t.route) && t.route.length > 0)
  if (routedTraces.length > 0) return

  const board = circuitJson.find((e: any) => e.type === "pcb_board") as any
  const comps = circuitJson.filter((e: any) => e.type === "pcb_component") as any[]
  const boardWidth = board?.width ?? 0
  const boardHeight = board?.height ?? 0
  const boardArea = boardWidth * boardHeight

  throw new Error(
    `PCB autorouting produced 0 routed traces out of ${traces.length} ` +
    `(netlist requires routing for ${netsNeedingRouting.length} net(s)) for design "${nir.design_id}": ` +
    `${comps.length} components on a ${boardWidth}x${boardHeight}mm board (${boardArea.toFixed(0)}mm^2). ` +
    `This is the known "board too small/dense to route" failure — CircuitRunner's internal autorouter ` +
    `found no legal path for at least one net and gave up on the whole board rather than partially routing. ` +
    `Try a larger board_spec width/height (this fixture's own default board routes successfully) or reduce ` +
    `component count/density; do not ship this output, it is silently missing all routing.`
  )
}

// Synchronous fallback for v1.1 (used when @tscircuit/eval unavailable or for sync API)
function parseNirV11Sync(nir: NirV11): AnyCircuitElement[] {
  requireKeys(nir, ["schema_version", "design_id", "components", "netlist", "board_spec"], "NIR v1.1 root")
  if (nir.schema_version !== "1.1" && nir.schema_version !== "1.2") {
    throw new Error(`NIR v1.1/v1.2 parser expects schema_version "1.1" or "1.2", got "${nir.schema_version}"`)
  }
  if (nir.components.length === 0) {
    throw new Error("NIR v1.1 `components` array is empty — refusing to emit empty Circuit JSON.")
  }
  return generateCircuitJsonFromNir(nir)
}

// --------------------------------------------------------------------------- //
// NIR v1.1 -> tscircuit JSX generation
// --------------------------------------------------------------------------- //

// tscircuit's `net.<name>` JSX prop syntax rejects certain characters at two
// layers:
//   1. createNetsFromProps regexes (@tscircuit/core):
//      - /net\.[^\s>]*\./   -> period rejected
//      - /net\.[^\s>]*[+-]/ -> "+" or "-" rejected
//      - /net\.[0-9]/       -> leading digit rejected
//   2. the runframe selector parser treats `(`, `)`, `>`, `<`, `~`, `+`, `.`,
//      `#`, `[`, `:`, and whitespace as structural characters (grouping,
//      child/parent/sibling/adjacent combinators, class/id/attribute/pseudo
//      selectors, descendant separators), so parens and those are rejected too.
// The safe set is therefore `[A-Za-z0-9_]`. Real-world KiCad auto-names like
// "Net-(C324-Pad1)" must be sanitized for the JSX prop. The original NIR net
// name is restored onto the emitted source_net elements after CircuitRunner
// returns (see restoreOriginalNetNames) so that net identity in Circuit JSON /
// netlist / DRC stays the source-of-truth name.
export function sanitizeNetNameForJsx(netName: string): string {
  let s = netName.replace(/[^A-Za-z0-9_]/g, "_")
  if (/^[0-9]/.test(s)) s = `_${s}`
  return s
}

// KiCad auto-names any net without a manually-assigned label
// "Net-(REF-PIN)" (e.g. "Net-(Q1-G)"). Fixtures extracted from a real board
// (like astracomputer) carry these verbatim in NIR net_name — confirmed
// against the real reference board's own KiCad project, these are KiCad's
// own auto-generated identifiers, not something this pipeline invents, and
// there is no "more real" name to recover from elsewhere in the NIR schema.
// They're still the most useful available identifier (component+pin), just
// wrapped in redundant boilerplate that's repeated on every pad of every
// such net and clutters dense boards. Strip the wrapper for display only;
// nets that already have a real name (GND, +3V3, /PWM1, ...) never match
// this pattern and are left untouched.
export function shortenAutoGeneratedNetName(name: string): string {
  const m = name.match(/^Net-\((.+)\)$/)
  return m ? m[1] : name
}

// After tscircuit runs, source_net.name holds the sanitized JSX prop string
// (tscircuit derives it from `new Net({ name: prop.split("net.")[1] })`).
// Restore the original NIR net_name (shortened per shortenAutoGeneratedNetName
// above) so downstream consumers (netlist export, DRC net matching, test
// points, and the final KiCad net table/pad labels) resolve against a
// display-friendly name instead of the sanitized JSX identifier. Trace
// connectivity is id-based (connected_source_net_ids), never name-based, so
// this rename is safe for routing and KiCad net sections.
function restoreOriginalNetNames(
  circuitJson: AnyCircuitElement[],
  netlist: NirV11NetlistEntry[],
): AnyCircuitElement[] {
  const sanitizedToOriginal = new Map<string, string>()
  for (const net of netlist) {
    const s = sanitizeNetNameForJsx(net.net_name)
    if (s !== net.net_name) sanitizedToOriginal.set(s, shortenAutoGeneratedNetName(net.net_name))
  }
  if (sanitizedToOriginal.size === 0) return circuitJson
  for (const el of circuitJson) {
    if (el.type === "source_net" && typeof (el as any).name === "string") {
      const original = sanitizedToOriginal.get((el as any).name)
      if (original) (el as any).name = original
    }
  }
  return circuitJson
}

// Footprint mapping: fixture names -> KiCad footprint strings from tscircuit (with kicad: prefix)
export const FOOTPRINT_MAP: Record<string, string> = {
  "MSOP-8":     "kicad:Package_SO/MSOP-8-1EP_3x3mm_P0.65mm_EP1.5x1.8mm",
  "SOT-23-5":   "kicad:Package_TO_SOT_SMD/SOT-23-5",
  "TSOT-23-5":  "kicad:Package_TO_SOT_SMD/TSOT-23-5",
  "MSOP-10":    "kicad:Package_SO/MSOP-10-1EP_3x3mm_P0.5mm_EP1.68x1.88mm",
  "SOIC-8":     "kicad:Package_SO/SOIC-8_3.9x4.9mm_P1.27mm",
  "0603":       "kicad:Resistor_SMD/R_0603_1608Metric",   // generic 0603, works for R/C
  "0402":       "kicad:Resistor_SMD/R_0402_1005Metric",
  "1206":       "kicad:Capacitor_SMD/C_1206_3216Metric",
  "SOT-23":     "kicad:Package_TO_SOT_SMD/SOT-23-5",      // TVS diode array likely 5-pin
}

export function kicadFootprint(fixtureName: string): string {
  const mapped = FOOTPRINT_MAP[fixtureName]
  if (mapped) return mapped
  const ci = fixtureName.indexOf(":")
  if (ci > 0 && ci < fixtureName.length - 1 && !fixtureName.startsWith("kicad:")) {
    const lib = fixtureName.slice(0, ci)
    const part = fixtureName.slice(ci + 1)
    return `kicad:${lib}/${part}`
  }
  return fixtureName
}

// Map fixture pin names -> tscircuit-valid pin labels (letters/numbers/underscores only)
const PIN_NAME_FIXUP: Record<string, string> = {
  "IN+": "INP",
  "IN-": "INN",
  "VCC": "VCC",
  "GND": "GND",
  "OUT": "OUT",
  "VIN": "VIN",
  "VOUT": "VOUT",
}

function fixPinName(pinName: string): string {
  return PIN_NAME_FIXUP[pinName] ?? pinName.replace(/[^A-Za-z0-9_]/g, "_")
}

// Some NIR fixtures carry only `pin_number` — fall back to the number when
// `pin_name` is absent so traces/pinLabels still resolve.
function pinLabelFor(conn: NirV11Connection): string {
  return conn.pin_name != null ? conn.pin_name : String(conn.pin_number ?? 1)
}

// Map semantic pin names (POSITIVE/NEGATIVE/IN/OUT/PIN1/PIN2) onto passive pin1/pin2
const SEMANTIC_TO_PASSIVE: Record<string, "pin1" | "pin2"> = {
  "POSITIVE": "pin1", "IN": "pin1", "ANODE": "pin1", "A": "pin1", "P": "pin1", "PIN1": "pin1",
  "NEGATIVE": "pin2", "OUT": "pin2", "CATHODE": "pin2", "K": "pin2", "N": "pin2", "PIN2": "pin2",
}

export function generateTscircuitJsx(nir: NirV11): string {
  const { components, netlist, board_spec } = nir

  const compRefSet = new Set(components.map(c => c.ref))

  // Build component JSX elements (with pinLabels for chips)
  const componentJsx = components.map(c => generateComponentJsx(c, netlist)).join("\n  ")

  // Map ref -> element type so traces can resolve passive pin numbering
  const refToType: Record<string, string> = {}
  for (const c of components) refToType[c.ref] = mapComponentType(c.component_type)
  const refIsConnector: Record<string, boolean> = {}
  for (const c of components) refIsConnector[c.ref] = c.component_type === "connector"

  // Build traces: one <trace> per (REF.PIN -> net.NAME) — skip phantom refs.
  //
  // Exception: reversible/mirrored connectors (e.g. USB-C receptacles) place
  // 2+ pins of the SAME component on the SAME net at literally the same
  // physical pad location (confirmed against a real reference board's
  // .kicad_pcb: J2's A1 and B12 pads both sit at `(at -3.2 -2.51 270)`,
  // identical coordinates — a real, deliberate footprint characteristic for
  // orientation-independent connectors, not a netlist error). Requiring the
  // autorouter to independently route to every one of those coincident
  // points creates a degenerate/impossible local clearance situation
  // (confirmed: @tscircuit/core's internal autorouter reliably fails to
  // route the entire board whenever such a component is present, regardless
  // of board size — removing just this one component restored 100% routing
  // success). Only the first pin per (component, net) gets an explicit
  // <trace>.
  //
  // NOTE: this dedup alone did NOT fully resolve astracomputer's routing
  // failure with J2 present — confirmed by direct re-test after this fix,
  // still fails identically at every board size tried. The real blocker is
  // deeper: @tscircuit/core's internal obstacle generation places a solid
  // inflated obstacle at each pad regardless of trace count, and two
  // pads at the exact same point still produce a degenerate/self-
  // overlapping obstacle the autorouter can't route around. This dedup is
  // kept anyway as a correct, harmless simplification (it does remove
  // genuinely redundant route requirements), but closing the gap for real
  // needs either a connector-aware clearance exception in the (third-
  // party, unmodified) autorouter or a different footprint-generation
  // strategy for coincident-pad connectors — out of scope here. See
  // PCB_LAYOUT_REPORT.md for the full investigation and current status.
  // The pins skipped here still show as unconnected (net 0) in the final
  // KiCad output rather than sharing their mirror pin's net — a known,
  // documented gap, not something this dedup silently hides.
  const traceLines: string[] = []
  const refsInNetlist = new Set<string>()
  const seenConnectorRefNetPairs = new Set<string>()
  for (const net of netlist) {
    for (const conn of net.connections) {
      if (!compRefSet.has(conn.ref)) continue // off-schema refs (Battery, headers) — skip
      refsInNetlist.add(conn.ref)
      if (refIsConnector[conn.ref]) {
        const refNetKey = `${conn.ref} ${net.net_name}`
        if (seenConnectorRefNetPairs.has(refNetKey)) continue
        seenConnectorRefNetPairs.add(refNetKey)
      }
      const elementType = refToType[conn.ref]
      const isPassive = elementType === "resistor" || elementType === "capacitor" || elementType === "diode" || elementType === "inductor"
      // Passives only have pin1/pin2 — resolve semantic alias if present
      // Chips use fixed pin names valid in tscircuit (letters/numbers/underscores)
      const pinName = pinLabelFor(conn)
      const pin = isPassive && SEMANTIC_TO_PASSIVE[pinName]
        ? SEMANTIC_TO_PASSIVE[pinName]
        : isPassive
          ? pinName
          : fixPinName(pinName)
      traceLines.push(`    <trace from="${conn.ref}.${pin}" to="net.${sanitizeNetNameForJsx(net.net_name)}" />`)
    }
  }

  // Emit test-point stubs for components with NO netlist connections (floating parts)
  for (const comp of components) {
    if (refsInNetlist.has(comp.ref)) continue
    const elementType = refToType[comp.ref]
    const isPassive = elementType === "resistor" || elementType === "capacitor" || elementType === "diode" || elementType === "inductor"
    if (isPassive) {
      // Passives: emit two stub traces to NC net (pin1 & pin2)
      traceLines.push(`    <trace from="${comp.ref}.pin1" to="net.NC_${comp.ref}_1" />`)
      traceLines.push(`    <trace from="${comp.ref}.pin2" to="net.NC_${comp.ref}_2" />`)
    } else {
      // Chips: emit one stub per declared pinLabel (fallback to pin1 if none)
      // Note: pinLabels are generated in generateComponentJsx; here we conservatively emit pin1
      traceLines.push(`    <trace from="${comp.ref}.pin1" to="net.NC_${comp.ref}_1" />`)
    }
  }

  const traceJsx = traceLines.join("\n")

  // Board dimensions from board_spec (fallback: sensible defaults).
  //
  // NOTE: board_spec never actually carries width/height (it's stackup
  // metadata only). The real board outline, when extracted from a source
  // .kicad_pcb, lives in `_NEW_mechanical_constraints.board_outline`
  // (astracomputer: 42x85mm rounded rect). Wiring those real dimensions
  // into this <board> tag was tried and reverted: tscircuit's default
  // auto-placement doesn't adapt to a tighter/differently-shaped board, so
  // shrinking astracomputer's virtual board from 80x60 to its true 42x85
  // made 100+ components no longer fit the placement area the autorouter
  // assumes, and CapacityMeshSolver/AutoroutingPipelineSolver aborted with
  // "ran out of iterations" instead of producing a route. Getting the real
  // outline size AND working placement/routing needs a placement-density
  // fix (packing components to actually fit the true board), which is a
  // separate, larger effort — see PCB_LAYOUT_REPORT.md.
  const boardWidth = board_spec?.width ?? 80  // mm
  const boardHeight = board_spec?.height ?? 60 // mm

  return `import { board, ${getUniqueIntrinsics(components).join(", ")} } from "tscircuit"

export default () => (
  <board
    width="${boardWidth}mm"
    height="${boardHeight}mm"
    layers={${board_spec.layers}}
  >
    ${componentJsx}

${traceJsx}
  </board>
)`
}

// Build an inline tscircuit <footprint> JSX block from NIR-provided real pad
// geometry (see NirV11FootprintPad / comp.custom_footprint_pads). Used in
// place of a string footprint reference so PCB rendering never depends on
// kicad-mod-cache.tscircuit.com having a copy of a project-custom KiCad
// footprint — it never will, since those "Library:"/custom "Sensors:" names
// aren't part of the official KiCad footprint libraries the cache mirrors.
//
// Coordinate/rotation convention: pad x_mm/y_mm/rotation_deg are copied
// verbatim from the source .kicad_pcb's pad `(at x y rot)` s-expression —
// i.e. KiCad's native pad-local frame (position relative to the footprint's
// own unrotated origin) with KiCad's clockwise-positive rotation. This
// pipeline's own kicadPcbWriter.ts establishes (see its "KiCad uses CW
// rotation" comment) that circuit-json/tscircuit angles are the
// CCW-positive complement of KiCad's, and that no Y-axis flip is applied
// between the two conventions anywhere else in this pipeline — so x_mm/y_mm
// are passed straight through here and rotation_deg is negated for
// ccwRotation. This has NOT been visually verified against a render (no
// live run in this environment) — sanity-check pad placement/orientation
// against the datasheet after running render:pcb, and flip the rotation
// sign here if any pad looks mirrored or rotated the wrong way.
function generateInlineFootprintJsx(pads: NirV11FootprintPad[]): string {
  const padJsx = pads.map((p) => {
    const ccwRotation = ((-(p.rotation_deg ?? 0) % 360) + 360) % 360
    const rotAttr = ccwRotation ? ` ccwRotation={${ccwRotation}}` : ""
    if (p.type === "thru_hole") {
      // tscircuit <platedhole> only supports a circular shape; a KiCad
      // "custom" shaped thru-hole pad (see _note) is approximated as a
      // circle sized to the pad's bounding box.
      const outerDiameter = Math.max(p.width_mm, p.height_mm)
      const holeDiameter = p.drill_mm ?? outerDiameter * 0.7
      return `<platedhole portHints={["${p.pin}"]} pcbX="${p.x_mm}mm" pcbY="${p.y_mm}mm" outerDiameter="${outerDiameter}mm" holeDiameter="${holeDiameter}mm" shape="circle" />`
    }
    // KiCad "oval"/"circle" pads: tscircuit <smtpad> has no oval primitive.
    // Every oval pad in this fixture is width===height (a round pad drawn as
    // an oval), so a circle of the same diameter is exact, not an
    // approximation — this only degrades fidelity if a *non-square* oval
    // pad is ever added upstream, in which case width/height should be
    // checked here and mapped to shape="pill" instead.
    if (p.shape === "oval" || p.shape === "circle") {
      const radius = Math.max(p.width_mm, p.height_mm) / 2
      return `<smtpad portHints={["${p.pin}"]} pcbX="${p.x_mm}mm" pcbY="${p.y_mm}mm" radius="${radius}mm" shape="circle" />`
    }
    return `<smtpad portHints={["${p.pin}"]} pcbX="${p.x_mm}mm" pcbY="${p.y_mm}mm" width="${p.width_mm}mm" height="${p.height_mm}mm" shape="rect"${rotAttr} />`
  }).join("\n      ")
  return `{<footprint>\n      ${padJsx}\n    </footprint>}`
}

function generateComponentJsx(comp: NirV11Component, netlist: NirV11NetlistEntry[]): string {
  const elementType = mapComponentType(comp.component_type)
  const isPassive = elementType === "resistor" || elementType === "capacitor" || elementType === "diode" || elementType === "inductor"
  const isSimulationOnly = comp.component_type === "simulation_source"

  // Collect this component's pin names from the netlist (with pin_number for chips)
  const pinNames = new Set<string>()
  const pinNumberMap = new Map<string, string>() // pin_name -> pin_number (as string)
  for (const net of netlist) {
    for (const conn of net.connections) {
      if (conn.ref === comp.ref) {
        pinNames.add(pinLabelFor(conn))
        if (conn.pin_number != null) pinNumberMap.set(pinLabelFor(conn), String(conn.pin_number))
      }
    }
  }

  const props: string[] = [
    `name="${comp.ref}"`,
  ]

  // Simulation-only sources (e.g. SPICE VPULSE) have footprint:null by design
  // (DNP — do not populate). Skip the footprint prop so kicadFootprint() never
  // receives null.
  //
  // Components carrying `custom_footprint_pads` (real pad geometry lifted
  // straight from a source .kicad_pcb — see NirV11FootprintPad) get an
  // inline <footprint> built from that data instead of a "kicad:lib/part"
  // string reference. This is required for any footprint namespaced outside
  // the official KiCad libraries (a project-local "Library:" or a
  // hand-rolled "Sensors:<custom>" path): kicad-mod-cache.tscircuit.com only
  // mirrors the official libraries, so those string references 404 forever.
  if (!isSimulationOnly) {
    const customPads = comp.custom_footprint_pads
    if (customPads && customPads.length > 0) {
      props.push(`footprint=${generateInlineFootprintJsx(customPads)}`)
    } else {
      props.push(`footprint="${kicadFootprint(comp.footprint)}"`)
    }
  }

  // Value prop depends on component type
  // TODO: values may arrive as Unicode/unit strings ("1µF", "600R@100MHz") per
  // schema v1.2. The async tscircuit path may reject or mis-parse these; if that
  // path gets exercised for v1.2 fixtures, normalize to ASCII ("1u" style) here.
  if (elementType === "resistor" && comp.value != null) props.push(`resistance="${comp.value}"`)
  else if (elementType === "capacitor" && comp.value != null) props.push(`capacitance="${comp.value}"`)
  else if (elementType === "inductor" && comp.value != null) props.push(`inductance="${comp.value}"`)
  else if (comp.value != null) props.push(`value="${comp.value}"`)

  // Chips need pinLabels so traces can reference named pins
  if (!isPassive && pinNames.size > 0) {
    // Use pin_number from netlist for correct physical pin assignment.
    // tscircuit's `pinLabels` prop keys are validated as strictly
    // `pin${number}` — some real footprints (e.g. USB-C receptacles, which
    // use J-STD alphanumeric pin numbers like "A1"/"B12"/"S1" as their
    // actual KiCad pad numbers, confirmed against a real reference board's
    // .kicad_pcb) have netlist pin_numbers that are NOT purely numeric.
    // Passing those straight through as `pinA1: ...` fails tscircuit's
    // prop validation and silently drops the whole component. Real
    // numeric pin_numbers keep using their real number as the key (as
    // before); non-numeric ones get an arbitrary sequential numeric key
    // instead — the key only needs to be a unique `pin<N>` slot, the pin's
    // real identity is carried by the *value* (fixedName), which is what
    // trace references (`J2.A1`) and downstream footprint pad matching
    // actually resolve against.
    const sortedNames = Array.from(pinNames).sort((a, b) => {
      const pa = Number(pinNumberMap.get(a))
      const pb = Number(pinNumberMap.get(b))
      const na = Number.isFinite(pa) ? pa : Infinity
      const nb = Number.isFinite(pb) ? pb : Infinity
      return na - nb
    })
    const takenNumericKeys = new Set(
      sortedNames
        .map((name) => Number(pinNumberMap.get(name)))
        .filter((n) => Number.isInteger(n)),
    )
    let nextFallbackKey = 1
    const pinLabelsObj = sortedNames
      .map((name) => {
        const raw = pinNumberMap.get(name)
        const numeric = raw != null ? Number(raw) : NaN
        let physPin: number
        if (Number.isInteger(numeric)) {
          physPin = numeric
        } else {
          while (takenNumericKeys.has(nextFallbackKey)) nextFallbackKey++
          physPin = nextFallbackKey++
          takenNumericKeys.add(physPin)
        }
        const fixedName = fixPinName(name)
        return `pin${physPin}: "${fixedName}"`
      })
      .join(", ")
    props.push(`pinLabels={{ ${pinLabelsObj} }}`)
  }

  // Footprint is the authoritative pin-count source for ICs. tscircuit sizes
  // the schematic box from the highest pin in pinLabels when the footprint is
  // not footprinter-parseable — a sparse netlist must never shrink the drawn
  // box below the package's real pin count. schPortArrangement is checked
  // FIRST by @tscircuit/core's _getPrimaryPinCount and forces ports 1..N.
  if (!isPassive && !isSimulationOnly) {
    const footprintPinCount = parsePinCountFromFootprint(comp.footprint)
    if (footprintPinCount !== null) {
      const refsPinNumbers = Array.from(pinNumberMap.values())
        .map(Number)
        .filter(Number.isFinite)
      const maxReferencedPin = refsPinNumbers.length > 0 ? Math.max(...refsPinNumbers) : 0
      if (maxReferencedPin > footprintPinCount) {
        throw new Error(
          `NIR data inconsistency: component ${comp.ref} footprint "${comp.footprint}" implies ${footprintPinCount} pins but the netlist references pin ${maxReferencedPin}.`,
        )
      }
      // Connectors (SMA/coax jacks, headers, etc.) routinely have several
      // mechanical or shield pins that are electrically redundant (e.g. an
      // SMA jack's 3-4 ground tabs alongside the one pin actually tied to
      // GND) and are legitimately absent from the netlist. The "under half
      // the pins wired" heuristic below is aimed at catching genuinely
      // incomplete IC netlists and produces false positives for connectors.
      if (comp.component_type !== "connector" && pinNames.size > 0 && pinNames.size * 2 < footprintPinCount) {
        console.warn(
          `[serializer] Component ${comp.ref} (footprint: "${comp.footprint}", ${footprintPinCount} pins) netlist only references ${pinNames.size} pin(s) — drawing the full ${footprintPinCount}-pin box. The netlist may be incomplete.`,
        )
      }
      const leftSize = Math.ceil(footprintPinCount / 2)
      const rightSize = Math.floor(footprintPinCount / 2)
      props.push(`schPortArrangement={{ leftSize: ${leftSize}, rightSize: ${rightSize} }}`)
    } else {
      console.warn(
        `[serializer] Cannot determine pin count for IC ${comp.ref} (footprint: "${comp.footprint}") — rendering a 2-pin box. Add the package pin count to KNOWN_PACKAGE_PIN_COUNTS.`,
      )
      props.push(`schPortArrangement={{ leftSize: 1, rightSize: 1 }}`)
    }
  }

  return `    <${elementType} ${props.join(" ")} />`
}

function mapComponentType(type: string): string {
  const map: Record<string, string> = {
    "resistor": "resistor",
    "capacitor": "capacitor",
    "voltage_reference": "chip",
    "ldo_regulator": "chip",
    "instrumentation_amp": "chip",
    "digital_potentiometer": "chip",
    "opamp": "chip",
    "diode": "diode",
    "tvs_diode_array": "diode",
    "ferrite_bead": "inductor",
  }
  return map[type.toLowerCase()] ?? "chip"
}

function getUniqueIntrinsics(components: NirV11Component[]): string[] {
  const types = new Set<string>()
  for (const c of components) {
    types.add(mapComponentType(c.component_type))
  }
  return Array.from(types).sort()
}

// --------------------------------------------------------------------------- //
// Actually run tscircuit JSX through CircuitRunner (async)
// --------------------------------------------------------------------------- //

async function runTscircuit(jsxFiles: Record<string, string>): Promise<AnyCircuitElement[]> {
  // Dynamic import to avoid hard dependency if @tscircuit/eval not installed
  let CircuitRunner: any
  try {
    const mod = await import("@tscircuit/eval")
    CircuitRunner = mod.CircuitRunner
  } catch {
    throw new Error("@tscircuit/eval not installed. Run `npm install @tscircuit/eval` to enable v1.1 tscircuit-native path.")
  }

  const runner = new CircuitRunner()
  try {
    await runner.executeWithFsMap({
      fsMap: jsxFiles,
      mainComponentPath: "circuit.tsx",
    })
    await runner.renderUntilSettled()
    const circuitJson = await runner.getCircuitJson()
    return circuitJson
  } finally {
    await runner.kill()
  }
}

// --------------------------------------------------------------------------- //
// Synchronous fallback: generate Circuit JSON directly from NIR
// (used by nirToCircuitJson which must remain synchronous)
// --------------------------------------------------------------------------- //

function generateCircuitJsonFromNir(nir: NirV11): AnyCircuitElement[] {
  const out: AnyCircuitElement[] = []

  // 1. pcb_board from board_spec
  out.push(emitPcbBoard(nir.board_spec))

  // Highest netlist-referenced pin per component ref. Only the netlist
  // constrains what we are allowed to draw; the footprint decides how many
  // pins the part actually has.
  const maxReferencedPinByRef = new Map<string, number>()
  for (const net of nir.netlist) {
    for (const conn of net.connections) {
      const n = Number(conn.pin_number)
      if (Number.isFinite(n)) {
        maxReferencedPinByRef.set(
          conn.ref,
          Math.max(maxReferencedPinByRef.get(conn.ref) ?? 0, n),
        )
      }
    }
  }

  // 2. Components: source_component_base + pcb_component + schematic_component
  for (let i = 0; i < nir.components.length; i++) {
    const comp = nir.components[i]
    requireKeys(
      comp as Record<string, unknown>,
      ["ref", "component_id", "component_type", "footprint", "position"],
      `NIR v1.1 components[${i}]`,
    )
    out.push(emitSourceComponentBase(comp))

    // Position: use explicit if provided, else naive layout
    const pos = (comp.position && typeof comp.position.x_mm === "number" && typeof comp.position.y_mm === "number")
      ? { x: comp.position.x_mm, y: comp.position.y_mm, rot: typeof comp.position.rotation_deg === "number" ? comp.position.rotation_deg : 0 }
      : naivePosition(comp.ref, i)

    out.push(emitPcbComponent(comp, pos.x, pos.y, pos.rot))
    out.push(...emitSchematicComponent(comp, pos.x, pos.y, DEFAULT_SCHEMATIC_SHEET_ID, maxReferencedPinByRef.get(comp.ref)))
  }

  // 3. Nets + traces from netlist
  for (const net of nir.netlist) {
    out.push(emitSourceNet(net))
    for (const conn of net.connections) {
      out.push(emitSourceTrace(net, conn))
    }
    if (net.net_type === "ground" || net.net_type === "power") {
      let sx = 10
      let sy = 10
      if (net.connections.length > 0) {
        const firstRef = net.connections[0].ref
        const comp = nir.components.find(c => c.ref === firstRef)
        if (comp && comp.position && typeof comp.position.x_mm === "number" && typeof comp.position.y_mm === "number") {
          sx = comp.position.x_mm + (net.net_type === "ground" ? 0 : 3)
          sy = comp.position.y_mm + (net.net_type === "ground" ? 4 : -3)
        }
      }
      out.push(...emitPowerSymbol(net, sx, sy, DEFAULT_SCHEMATIC_SHEET_ID))
    }
  }

  return out
}

// --------------------------------------------------------------------------- //
// Shared v1.1 helpers (kept from previous implementation for Circuit JSON emit)
// --------------------------------------------------------------------------- //

const NAIVE_LAYOUT_COLS = 4
const NAIVE_LAYOUT_ORIGIN_MM = { x: 10, y: 10 }
const NAIVE_LAYOUT_PITCH_MM = 12

const FOOTPRINT_SIZE_MM: Record<string, { width: number; height: number }> = {
  "0402": { width: 1.0, height: 0.5 },
  "0603": { width: 1.6, height: 0.8 },
  "0805": { width: 2.0, height: 1.25 },
  "1206": { width: 3.2, height: 1.6 },
  "SOT-23":     { width: 2.9, height: 1.3 },
  "SOT-23-5":   { width: 2.9, height: 1.6 },
  "TSOT-23-5":  { width: 2.9, height: 1.6 },
  "MSOP-8":     { width: 3.0, height: 3.0 },
  "MSOP-10":    { width: 3.0, height: 3.0 },
  "SOIC-8":     { width: 3.9, height: 4.9 },
}

const KNOWN_FP_KEYS: Record<string, { width: number; height: number }> = {
  "0603": { width: 4.45, height: 2.95 },
  "0402": { width: 2.3, height: 1.5 },
  "1206": { width: 6.0, height: 3.5 },
  "MSOP-8": { width: 7.85, height: 4.35 },
  "MSOP-10": { width: 7.85, height: 4.35 },
  "SOIC-8": { width: 8.90, height: 6.41 },
  "SOT-23": { width: 2.9, height: 1.3 },
  "SOT-23-5": { width: 2.9, height: 1.6 },
  "TSOT-23-5": { width: 2.9, height: 1.6 },
}

function shortFootprintName(name: string): string {
  const trimmed = name.replace(/^kicad:[^/]+\//, "")
  for (const key of Object.keys(KNOWN_FP_KEYS)) {
    if (trimmed.includes(key)) return key
  }
  return trimmed
}

function lookupFootprintSize(footprint: string): { width: number; height: number } {
  const sz = FOOTPRINT_SIZE_MM[footprint] ?? KNOWN_FP_KEYS[footprint]
  if (sz) return sz
  const short = shortFootprintName(footprint)
  const found = KNOWN_FP_KEYS[short]
  if (found) return found
  throw new Error(`Unknown footprint '${footprint}' — add to FOOTPRINT_SIZE_MM`)
}

const MATERIAL_MAP: Record<string, "fr4" | "fr1"> = { "FR4": "fr4", "FR1": "fr1" }

const NAIVE_BOARD_FALLBACK_MM = { width: 80, height: 60 }

function emitPcbBoard(spec: NirV11BoardSpec): AnyCircuitElement {
  requireKeys(spec as Record<string, unknown>, ["layers", "material", "thickness_mm"], "NIR v1.1 board_spec")
  const material = MATERIAL_MAP[String(spec.material).toUpperCase()]
  if (!material) {
    throw new Error(`board_spec.material '${spec.material}' not mapped (expected FR4/FR1)`)
  }
  return {
    type: "pcb_board",
    pcb_board_id: "pcb_board_default",
    width: NAIVE_BOARD_FALLBACK_MM.width,
    height: NAIVE_BOARD_FALLBACK_MM.height,
    thickness: spec.thickness_mm,
    num_layers: spec.layers,
    material,
    center: { x: 0, y: 0 },
    shape: "rect",
  } as AnyCircuitElement
}

function emitSourceComponentBase(comp: NirV11Component): AnyCircuitElement {
  return {
   type: "source_component_base",
    source_component_id: `${comp.ref}_source`,
    name: comp.ref,
    component_type: comp.component_type,
    component_id: comp.component_id,
    footprint: comp.footprint,
  } as AnyCircuitElement
}

function emitPcbComponent(
  comp: NirV11Component,
  x: number,
  y: number,
  rot: number,
): AnyCircuitElement {
  const parsed = getParsedFootprintSize(comp.footprint)
  const sz = parsed ?? lookupFootprintSize(comp.footprint)
  return {
    type: "pcb_component",
    pcb_component_id: `${comp.ref}_pcb`,
    source_component_id: `${comp.ref}_source`,
    center: { x, y },
    layer: "top",
    rotation: rot,
    width: sz.width,
    height: sz.height,
    obstructs_within_bounds: true,
  } as AnyCircuitElement
}

const SYMBOL_DISCRETE_W = 6
const SYMBOL_DISCRETE_H = 2
const SYMBOL_IC_W = 10
const SYMBOL_IC_H = 6
const SYMBOL_TEXT_REF_FONT = 1.2
const SYMBOL_TEXT_VAL_FONT = 1.0
const SYMBOL_TEXT_OFFSET = 1.8

// Single default schematic sheet. Every schematic element emitted by the sync
// path is tagged with this id so multi-sheet support (hierarchical_sheets)
// can be added later by grouping on schematic_sheet_id without retrofitting
// each emit call site. A `schematic_sheet` element is NOT emitted today so the
// rendered single-sheet output stays byte-identical.
const DEFAULT_SCHEMATIC_SHEET_ID = "schematic_sheet_default"

function emitSchematicComponent(
  comp: NirV11Component,
  x: number,
  y: number,
  schematicSheetId: string = DEFAULT_SCHEMATIC_SHEET_ID,
  maxReferencedPin?: number,
): AnyCircuitElement[] {
  const refSchId = `${comp.ref}_sch`
  const isIc = isIC(comp.component_type)
  // Footprint is the authoritative pin-count source. The netlist is NOT: a
  // sparse netlist (e.g. only 1 of 36 pins referenced) must never shrink the
  // drawn pin count below what the package actually has.
  const footprintPinCount = parsePinCountFromFootprint(comp.footprint)
  let pinCount: number
  if (isIc && footprintPinCount !== null) {
    if (maxReferencedPin !== undefined && maxReferencedPin > footprintPinCount) {
      throw new Error(
        `NIR data inconsistency: component ${comp.ref} footprint "${comp.footprint}" implies ${footprintPinCount} pins but the netlist references pin ${maxReferencedPin}.`,
      )
    }
    pinCount = footprintPinCount
  } else if (isIc) {
    console.warn(
      `[serializer] Cannot determine pin count for IC ${comp.ref} (footprint: "${comp.footprint}") — rendering a 2-pin box. Add the package pin count to KNOWN_PACKAGE_PIN_COUNTS.`,
    )
    pinCount = 2
  } else {
    pinCount = inferPinCount(comp.footprint)
  }
  const elements: AnyCircuitElement[] = []

  const partNumber = typeof comp.value === "string" ? comp.value : undefined
  const kicadSym = lookupKicadSymbol(comp.component_type, partNumber)
  const sym = lookupSymbol(comp.component_type)
  if (!kicadSym && !sym) logMissingSymbol(comp.component_type)

  if (kicadSym) {
    const bb = kicadSym.bodyBox
    const bodyW = Math.max(bb.width, 2)
    const bodyH = Math.max(bb.height, 2)

    elements.push({
      type: "schematic_component",
      schematic_component_id: refSchId,
      source_component_id: `${comp.ref}_source`,
      center: { x, y },
      size: { width: bodyW, height: bodyH },
      is_box_with_pins: false,
      symbol_display_value: typeof comp.value === "string" ? comp.value : undefined,
      schematic_sheet_id: schematicSheetId,
    } as AnyCircuitElement)

    for (const prim of kicadSym.primitives) {
      if (prim.type === "rectangle" && prim.start && prim.end) {
        elements.push({
          type: "schematic_box",
          schematic_component_id: refSchId,
          x: x + prim.start.x,
          y: y + prim.start.y,
          width: prim.end.x - prim.start.x,
          height: prim.end.y - prim.start.y,
          is_dashed: false,
          schematic_sheet_id: schematicSheetId,
        } as AnyCircuitElement)
      } else if (prim.type === "polyline" && prim.points && prim.points.length > 1) {
        const absPoints = prim.points.map(p => ({ x: x + p.x, y: y + p.y }))
        elements.push({
          type: "schematic_path",
          schematic_path_id: `kpath_${refSchId}_${elements.length}`,
          schematic_component_id: refSchId,
          points: absPoints,
          is_filled: !!prim.filled,
          fill_color: prim.filled ? "#0c1e2e" : undefined,
          schematic_sheet_id: schematicSheetId,
        } as AnyCircuitElement)
      } else if (prim.type === "pin" && prim.pin) {
        const px = x + prim.pin.x
        const py = y + prim.pin.y
        const angleRad = (prim.pin.angle * Math.PI) / 180
        const ex = px + Math.cos(angleRad) * prim.pin.length
        const ey = py - Math.sin(angleRad) * prim.pin.length

        elements.push({
          type: "schematic_line",
          schematic_line_id: `kline_${refSchId}_${prim.pin.number}`,
          schematic_component_id: refSchId,
          x1: ex, y1: ey, x2: px, y2: py,
          color: "#0c1e2e",
          is_dashed: false,
          schematic_sheet_id: schematicSheetId,
        } as AnyCircuitElement)

        const portIdx = kicadSym.ports.findIndex(p => p.number === prim.pin!.number)
        if (portIdx >= 0) {
          elements.push({
            type: "schematic_port",
            schematic_port_id: `kport_${refSchId}_${prim.pin.number}`,
            source_port_id: `${comp.ref}_source_port_${prim.pin.number}`,
            schematic_component_id: refSchId,
            center: { x: px, y: py },
            facing_angle: prim.pin.angle,
            display_pin_label: prim.pin.name || prim.pin.number,
            schematic_sheet_id: schematicSheetId,
          } as AnyCircuitElement)
        }
      }
    }

    const bodyH2 = bodyH
    elements.push({
      type: "schematic_text",
      schematic_text_id: `${refSchId}_reftext`,
      text: comp.ref,
      font_size: SYMBOL_TEXT_REF_FONT,
      position: { x, y: y + bodyH2 / 2 + 1.8 },
      rotation: 0,
      anchor: "center",
      color: "#000",
      schematic_sheet_id: schematicSheetId,
    } as AnyCircuitElement)

    if (typeof comp.value === "string" && comp.value.length > 0) {
      elements.push({
        type: "schematic_text",
        schematic_text_id: `${refSchId}_valtext`,
        text: comp.value,
        font_size: SYMBOL_TEXT_VAL_FONT,
        position: { x, y: y - bodyH2 / 2 - 1.8 },
        rotation: 0,
        anchor: "center",
        color: "#333",
        schematic_sheet_id: schematicSheetId,
      } as AnyCircuitElement)
    }

    return elements
  }

  const bodySize = sym
    ? { width: sym.width, height: sym.height }
    : isIc
      ? { width: SYMBOL_IC_W, height: SYMBOL_IC_H + Math.max(0, Math.ceil(pinCount / 2) - 4) }
      : { width: SYMBOL_DISCRETE_W, height: SYMBOL_DISCRETE_H }

  elements.push({
    type: "schematic_component",
    schematic_component_id: refSchId,
    source_component_id: `${comp.ref}_source`,
    center: { x, y },
    size: bodySize,
    is_box_with_pins: sym ? true : !["resistor", "capacitor", "diode", "tvs_diode_array"].includes(comp.component_type),
    symbol_name: sym?.symbolName,
    symbol_display_value: typeof comp.value === "string" ? comp.value : undefined,
    schematic_sheet_id: schematicSheetId,
  } as AnyCircuitElement)

  if (!sym) {
    elements.push(...makeSymbolGeometry(comp, refSchId, x, y, bodySize, pinCount, schematicSheetId))
  }

  const bodyH = bodySize.height
  elements.push({
    type: "schematic_text",
    schematic_text_id: `${refSchId}_reftext`,
    text: comp.ref,
    font_size: SYMBOL_TEXT_REF_FONT,
    position: { x, y: y + bodyH / 2 + 1.8 },
    rotation: 0,
    anchor: "center",
    color: "#000",
    schematic_sheet_id: schematicSheetId,
  } as AnyCircuitElement)

  if (typeof comp.value === "string" && comp.value.length > 0) {
    elements.push({
      type: "schematic_text",
      schematic_text_id: `${refSchId}_valtext`,
      text: comp.value,
      font_size: SYMBOL_TEXT_VAL_FONT,
      position: { x, y: y - bodyH / 2 - 1.8 },
      rotation: 0,
      anchor: "center",
      color: "#333",
      schematic_sheet_id: schematicSheetId,
    } as AnyCircuitElement)
  }

  return elements
}

function makeSymbolGeometry(
  comp: NirV11Component,
  sid: string,
  cx: number,
  cy: number,
  bodySize: { width: number; height: number },
  pinCount: number,
  schematicSheetId: string = DEFAULT_SCHEMATIC_SHEET_ID,
): AnyCircuitElement[] {
  const ct = comp.component_type
  const wire = "#0c1e2e"
  const w2 = bodySize.width / 2
  const h2 = bodySize.height / 2

  if (ct === "resistor") {
    // Zigzag
    const x0 = cx - w2
    const pts = [
      { x: x0, y: cy },
      { x: x0 + 0.4, y: cy },
      { x: x0 + 0.8, y: cy - h2 },
      { x: x0 + 1.6, y: cy + h2 },
      { x: x0 + 2.4, y: cy - h2 },
      { x: x0 + 3.2, y: cy + h2 },
      { x: x0 + 4.0, y: cy - h2 },
      { x: x0 + 4.8, y: cy + h2 },
      { x: x0 + 5.2, y: cy },
      { x: cx + w2, y: cy },
    ]
    return [
      schematicLine(sid, cx - w2 - 2, cy, x0, cy, wire, schematicSheetId),
      schematicLine(sid, cx + w2, cy, cx + w2 + 2, cy, wire, schematicSheetId),
      schematicPath(sid, pts, false, schematicSheetId),
    ]
  }
  if (ct === "capacitor") {
    const xL = cx - 0.8
    const xR = cx + 0.8
    const plateH = bodySize.height * 1.2
    return [
      schematicLine(sid, cx - SYMBOL_DISCRETE_W / 2 - 2, cy, xL, cy, wire, schematicSheetId),
      schematicLine(sid, cx - SYMBOL_DISCRETE_W / 2, cy, xL, cy, wire, schematicSheetId),
      schematicLine(sid, xL, cy - plateH / 2, xL, cy + plateH / 2, wire, schematicSheetId),
      schematicLine(sid, xR, cy - plateH / 2, xR, cy + plateH / 2, wire, schematicSheetId),
      schematicLine(sid, xR, cy, cx + SYMBOL_DISCRETE_W / 2 + 2, cy, wire, schematicSheetId),
    ]
  }
  if (ct === "tvs_diode_array" || ct === "diode") {
    const tri = 1.6
    const tip = cx + tri
    return [
      schematicLine(sid, cx - SYMBOL_DISCRETE_W / 2 - 2, cy, cx - tri, cy, wire, schematicSheetId),
      schematicPath(sid, [{ x: cx - tri, y: cy - 1 }, { x: cx - tri, y: cy + 1 }, { x: tip, y: cy }], true, schematicSheetId),
      schematicLine(sid, tip, cy - 1, tip, cy + 1, wire, schematicSheetId),
      schematicLine(sid, tip, cy, cx + SYMBOL_DISCRETE_W / 2 + 2, cy, wire, schematicSheetId),
    ]
  }
  if (ct === "ferrite_bead") {
    const w = SYMBOL_DISCRETE_W
    const h = SYMBOL_DISCRETE_H
    return [
      schematicBox(sid, cx - w / 2, cy - h / 2, w, h, false, schematicSheetId),
      schematicLine(sid, cx - w / 2 - 2, cy, cx - w / 2, cy, wire, schematicSheetId),
      schematicLine(sid, cx + w / 2, cy, cx + w / 2 + 2, cy, wire, schematicSheetId),
      schematicPath(sid, [{ x: cx - 1.5, y: cy }, { x: cx - 0.5, y: cy - 0.5 }, { x: cx + 0.5, y: cy + 0.5 }, { x: cx + 1.5, y: cy }], false, schematicSheetId),
    ]
  }
  // IC box with pin stubs
  const w = SYMBOL_IC_W
  const h = bodySize.height
  const out: AnyCircuitElement[] = []
  out.push(schematicBox(sid, cx - w / 2, cy - h / 2, w, h, false, schematicSheetId))
  const pins = pinCount
  const half = Math.ceil(pins / 2)
  for (let i = 0; i < half; i++) {
    const y = cy - h / 2 + 0.5 + i * (h / Math.max(half, 1)) * 0.8
    out.push(schematicLine(sid, cx - w / 2 - 1.5, y, cx - w / 2, y, wire, schematicSheetId))
  }
  const rightCount = pins - half
  for (let i = 0; i < rightCount; i++) {
    const y = cy - h / 2 + 0.5 + i * (h / Math.max(rightCount, 1)) * 0.8
    out.push(schematicLine(sid, cx + w / 2, y, cx + w / 2 + 1.5, y, wire, schematicSheetId))
  }
  if (comp.component_type === "digital_potentiometer") {
    out.push({ type: "schematic_text", schematic_text_id: `${sid}_lbl`, schematic_component_id: sid, text: "RH/W", font_size: 1.0, position: { x: cx, y: cy }, rotation: 0, anchor: "center", color: "#444", schematic_sheet_id: schematicSheetId } as AnyCircuitElement)
  }
  if (comp.component_type === "instrumentation_amp") {
    out.push({ type: "schematic_text", schematic_text_id: `${sid}_ia`, schematic_component_id: sid, text: "IA", font_size: 1.0, position: { x: cx, y: cy }, rotation: 0, anchor: "center", color: "#444", schematic_sheet_id: schematicSheetId } as AnyCircuitElement)
  }
  return out
}

function schematicLine(
  sid: string,
  x1: number, y1: number, x2: number, y2: number,
  color: string,
  schematicSheetId: string = DEFAULT_SCHEMATIC_SHEET_ID,
): AnyCircuitElement {
  return {
    type: "schematic_line",
    schematic_line_id: `line_${sid}_${Math.round(x1*1000)}_${Math.round(y1*1000)}_${Math.round(x2*1000)}_${Math.round(y2*1000)}`,
    schematic_component_id: sid,
    x1, y1, x2, y2,
    color,
    is_dashed: false,
    schematic_sheet_id: schematicSheetId,
  } as AnyCircuitElement
}

function schematicPath(
  sid: string,
  points: { x: number; y: number }[],
  filled = false,
  schematicSheetId: string = DEFAULT_SCHEMATIC_SHEET_ID,
): AnyCircuitElement {
  return {
    type: "schematic_path",
    schematic_path_id: `path_${sid}_${points.length}_${Math.round(points[0].x*1000)}_${Math.round(points[0].y*1000)}`,
    schematic_component_id: sid,
    points,
    is_filled: filled,
    fill_color: filled ? "#0c1e2e" : undefined,
    schematic_sheet_id: schematicSheetId,
  } as AnyCircuitElement
}

function schematicBox(
  sid: string,
  x: number, y: number, w: number, h: number,
  dashed = false,
  schematicSheetId: string = DEFAULT_SCHEMATIC_SHEET_ID,
): AnyCircuitElement {
  return {
    type: "schematic_box",
    schematic_component_id: sid,
    x, y, width: w, height: h,
    is_dashed: dashed,
    schematic_sheet_id: schematicSheetId,
  } as AnyCircuitElement
}

function emitSourceNet(net: NirV11NetlistEntry): AnyCircuitElement {
  return {
    type: "source_net",
    source_net_id: `net_${net.net_name}`,
    name: shortenAutoGeneratedNetName(net.net_name),
    member_source_group_ids: [],
    is_power: net.net_type === "power",
    is_ground: net.net_type === "ground",
    is_analog_signal: net.net_type === "analog",
  } as AnyCircuitElement
}

function emitPowerSymbol(
  net: NirV11NetlistEntry,
  x: number,
  y: number,
  schematicSheetId: string = DEFAULT_SCHEMATIC_SHEET_ID,
): AnyCircuitElement[] {
  const elements: AnyCircuitElement[] = []
  const schId = `net_${net.net_name}_sch`
  const sourceId = `net_${net.net_name}_source`

  if (net.net_type === "ground") {
    // Ground: use standard ground_down symbol from schematic-symbols
    elements.push({
      type: "schematic_component",
      schematic_component_id: schId,
      source_component_id: sourceId,
      center: { x, y },
      size: { width: 2, height: 2 },
      is_box_with_pins: true,
      symbol_name: getGroundSymbolName(),
      schematic_sheet_id: schematicSheetId,
    } as AnyCircuitElement)
  } else if (net.net_type === "power") {
    // Power nets (VIN, VCC, etc.): plain text label only, no graphic shape
    elements.push({
      type: "schematic_text",
      schematic_text_id: `${schId}_label`,
      text: net.net_name,
      font_size: 1.0,
      position: { x, y },
      rotation: 0,
      anchor: "center",
      color: "#c00",
      schematic_sheet_id: schematicSheetId,
    } as AnyCircuitElement)
  }

  return elements
}

function emitSourceTrace(
  net: NirV11NetlistEntry,
  conn: { ref: string; pin_name: string; pin_number: string | number },
): AnyCircuitElement {
  return {
    type: "source_trace",
    source_trace_id: `trace_${conn.ref}_${conn.pin_number}__net_${net.net_name}`,
    connected_source_port_ids: [`${conn.ref}_source_port_${conn.pin_number}`],
    connected_source_net_ids: [`net_${net.net_name}`],
  } as AnyCircuitElement
}

// Authoritative IC pin-count source. Package strings typically encode the pin
// count ("PowerSSO-36", "MSOP-8", "SOT-23-5"); full KiCad footprint refs
// ("kicad:Package_SO/MSOP-8-1EP_3x3mm_P0.65mm_EP1.5x1.8mm") carry it too.
// Returns null when no reliable count can be derived — callers must NOT silently
// fall back to "how many distinct pins the netlist happens to mention".
const KNOWN_PACKAGE_PIN_COUNTS: [string, number][] = ([
  ["TSOT-23-5", 5], ["SOT-23-5", 5],
  ["PowerSSO-36", 36], ["PowerSSO-24", 24],
  ["MSOP-10", 10], ["MSOP-8", 8],
  ["SOIC-16", 16], ["SOIC-14", 14], ["SOIC-8", 8], ["SOIC8", 8],
  ["TSSOP-20", 20], ["TSSOP-16", 16], ["TSSOP-14", 14], ["TSSOP-8", 8],
  ["QFN-32", 32], ["QFN-28", 28], ["QFN-24", 24], ["QFN-16", 16],
  ["QFP-64", 64], ["QFP-48", 48], ["QFP-44", 44], ["QFP-32", 32],
  ["LQFP-64", 64], ["LQFP-48", 48], ["LQFP-44", 44], ["LQFP-32", 32],
  ["DIP-20", 20], ["DIP-16", 16], ["DIP-14", 14], ["DIP-8", 8],
  ["SSOP-24", 24], ["SSOP-20", 20], ["SSOP-16", 16], ["SSOP-14", 14], ["SSOP-8", 8],
  ["SOP-16", 16], ["SOP-14", 14], ["SOP-8", 8],
  ["PLCC-44", 44], ["PLCC-32", 32], ["PLCC-28", 28], ["PLCC-20", 20],
  ["SOT-223", 4], ["SOT-89", 3], ["SOT-323", 3], ["SOT-23-6", 6], ["SOT-23", 3],
  ["TO-220-7", 7], ["TO-220-5", 5], ["TO-220-3", 3], ["TO-220", 3],
  ["TO-247-4", 4], ["TO-247-3", 3], ["TO-247", 3],
  ["TO-263-7", 7], ["TO-263-5", 5], ["TO-263-3", 3], ["TO-263", 3],
  ["TO-252-5", 5], ["TO-252-3", 3], ["TO-252", 3],
  ["D2PAK-7", 7], ["D2PAK-5", 5], ["D2PAK-3", 3], ["D2PAK", 3],
  ["DPAK-5", 5], ["DPAK-3", 3], ["DPAK", 3],
  ["TO-126", 3], ["TO-251", 3], ["TO-92", 3],

  // astracomputer fixture — package strings don't carry a recognizable pin
  // count token, so counts below were looked up from vendor datasheets/specs
  // (2026-08-16). See dev-tools/render_pcb_viewer.ts astracomputer run.
  ["SW_SPST_PTS810", 2],                     // Button_Switch_SMD:SW_SPST_PTS810 — tact switch, 2 elec. pin numbers (4 legs, KiCad stock footprint)
  ["BUZZER_12X9.5RM7.6", 2],                 // Buzzer_Beeper:Buzzer_12x9.5RM7.6 — 2-pin THT buzzer
  ["MICROSD_HC_HIROSE_DM3D-SF", 11],         // Connector_Card:... — Hirose DM3 series: 8 signal + 2 card-detect + 1 shield pad number (KiCad stock footprint has pads 1-11)
  ["USB_C_RECEPTACLE_PALCONN_UTC16-G", 17],  // Connector_USB:... — 16 signal positions (A/B rows) + 1 shield pad "S1" (KiCad stock footprint)
  ["LINX_CONSMA022-G", 5],                   // Library:... (custom) — verified against the real Astra_Computer_V2.kicad_pcb source: 1 signal (rect SMD) + 4 ground/shield legs (pads 2-5, thru-hole)
  ["L_0402_1005METRIC", 2],                  // Inductor_SMD:... — 2-pin inductor
  ["L_BOURNS-SRN4018", 2],                   // Inductor_SMD:... — 2-pin power inductor
  ["ESP32-S3-WROOM-1", 41],                  // RF_Module:ESP32-S3-WROOM-1(U) — Espressif datasheet: 41 pins, pin 41 = EPAD
  ["QFN10_BMP581_BOS", 10],                  // Library:... (custom) — Bosch BMP581: 10-pin LGA (cross-checked against Astra_Computer_V2.kicad_pcb: exactly 10 pads)
  ["LGA_M10Q-00B_UBL", 53],                  // Sensors:... (custom) — u-blox MIA-M10Q-00B: 53-pin S-LGA (cross-checked against Astra_Computer_V2.kicad_pcb: exactly 53 pads)
  ["IC_BNO085", 28],                         // Library:... (custom) — CEVA/Bosch BNO085: 28-pin LGA (cross-checked against Astra_Computer_V2.kicad_pcb: exactly 28 pads)
  ["CC7V-T1A-2PIN", 2],                      // Crystal:...CC7V-T1A-2Pin... — 2-pin crystal
] as [string, number][]).sort((a, b) => b[0].length - a[0].length)

export function parsePinCountFromFootprint(footprint: string): number | null {
  if (!footprint) return null
  const upper = footprint.toUpperCase()
  for (const [pkg, count] of KNOWN_PACKAGE_PIN_COUNTS) {
    if (upper.includes(pkg)) {
      // KiCad's "-1EP" suffix marks a single exposed pad beyond the signal
      // pins (e.g. QFN-32-1EP = 33 pads total; the EP is pin 33 in the
      // netlist).
      return /(?:^|[\-_/])1EP(?:[\-_/]|$)/.test(upper) ? count + 1 : count
    }
  }
  // Connector row×pins convention: "PinHeader_1x08", "PinHeader_2x03",
  // "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical" → rows × cols.
  // Gated on connector-family keywords so body dimensions like "3x3mm" in
  // KiCad package refs are never misread as 3×3 = 9 pins.
  const mRowPins = footprint.match(/(\d+)x(\d+)/i)
  if (
    mRowPins &&
    /(PINHEADER|HEADER|CONNECTOR|CONN|SOCKET|TERMINAL|TERMBLOCK|JST|XH|MOLEX)/i.test(upper)
  ) {
    const n = parseInt(mRowPins[1], 10) * parseInt(mRowPins[2], 10)
    if (Number.isFinite(n) && n >= 2 && n <= 256) return n
  }
  // Generic: a standalone numeric token between separators (e.g. "36" in
  // "IC-PowerSSO-36-EPU"). Rejects size codes like "0603"/"0805" (> 256) so
  // passive footprints never match.
  const m = footprint.match(/(?:^|[-_/])(\d{1,3})(?:[-_]|$)/)
  if (m) {
    const n = parseInt(m[1], 10)
    if (Number.isFinite(n) && n >= 2 && n <= 256) return n
  }
  return null
}

function inferPinCount(footprint: string): number {
  return parsePinCountFromFootprint(footprint) ?? 2
}

function isIC(componentType: string): boolean {
  return ["instrumentation_amp", "voltage_reference", "ldo_regulator", "digital_potentiometer", "mcu", "opamp", "logic"].includes(componentType)
}

function inferRefKind(ref: string): string {
  const m = String(ref).match(/^[A-Z]+/i)
  return m ? m[0].toUpperCase() : "?"
}

function naivePosition(ref: string, index: number): { x: number; y: number; rot: number } {
  const col = index % NAIVE_LAYOUT_COLS
  const row = Math.floor(index / NAIVE_LAYOUT_COLS)
  return {
    x: NAIVE_LAYOUT_ORIGIN_MM.x + col * NAIVE_LAYOUT_PITCH_MM,
    y: NAIVE_LAYOUT_ORIGIN_MM.y + row * NAIVE_LAYOUT_PITCH_MM,
    rot: 0,
  }
}

function requireKeys(obj: Record<string, unknown>, keys: string[], where: string): void {
  for (const k of keys) {
    const v = obj[k]
    if (v === undefined || v === null) {
      throw new Error(`${where} missing required field '${k}' — NIR v1.1 parsing is strict.`)
    }
  }
}

export function detectNirSchemaVersion(nir: unknown): NirSchemaVersion {
  if (!nir || typeof nir !== "object" || Array.isArray(nir)) {
    throw new Error("NIR root must be an object")
  }
  const o = nir as Record<string, unknown>
  if (o["schema_version"] === "1.1") return "v1.1-instrumentation"
  if (o["nir_schema_version"] === "0.1") return "v0.1-libbrecht"
  const cj = o["circuit_json"]
  if (cj && typeof cj === "object" && !Array.isArray(cj) && "components" in cj && ("nets" in cj || "traces" in cj)) {
    return "v0.1-libbrecht"
  }
  if (Array.isArray(o["components"]) && Array.isArray(o["netlist"]) && o["board_spec"] && typeof o["board_spec"] === "object") {
    return "v1.1-instrumentation"
  }
  const keys = Object.keys(o).sort().join(", ") || "(none)"
  throw new Error(`NIR schema version not recognized. Top-level keys: ${keys}`)
}

// --------------------------------------------------------------------------- //
// Circuit JSON -> SVG   (unchanged from prior implementation)
// --------------------------------------------------------------------------- //

export function renderCircuitJson(
  circuitJson: AnyCircuitElement[],
): { svg: string; viewerUsed: ViewerUsed } {
  const want = (process.env.KICAD_VIEWER ?? "").toLowerCase()

  if (want === "schematic-viewer") {
    try {
      const sv = require("@tscircuit/schematic-viewer")
      const svg = sv.renderCircuitJsonToSvg
        ? sv.renderCircuitJsonToSvg(circuitJson)
        : sv.default?.renderCircuitJsonToSvg?.(circuitJson)
      if (typeof svg === "string" && svg.length > 0) {
        return { svg, viewerUsed: "@tscircuit/schematic-viewer" }
      }
    } catch (e) {
      console.warn("[open_forge/serializer] @tscircuit/schematic-viewer not available, falling back to circuit-to-svg")
    }
  }

  const hasSchematic = circuitJson.some(
    (el) => typeof el === "object" && el !== null && String((el as any).type).startsWith("schematic"),
  ) || circuitJson.length === 0

  let svg: string
  try {
    svg = hasSchematic
      ? convertCircuitJsonToSchematicSvg(circuitJson as any)
      : convertCircuitJsonToPcbSvg(circuitJson as any)
  } catch {
    try {
      svg = convertCircuitJsonToPcbSvg(circuitJson as any)
    } catch (e) {
      throw new Error("circuit-to-svg failed to render both schematic and PCB views: " + String((e as Error)?.message ?? e))
    }
  }
  return { svg, viewerUsed: "circuit-to-svg" }
}

// --------------------------------------------------------------------------- //
// NIR -> Circuit JSON  (dispatched by version)
// --------------------------------------------------------------------------- //

export function nirToCircuitJson(nir: Nir | unknown): AnyCircuitElement[] {
  const version = detectNirSchemaVersion(nir)
  return version === "v0.1-libbrecht"
    ? parseNirV01(nir as Nir)
    : parseNirV11Sync(nir as unknown as NirV11)
}

// Async version that runs CircuitRunner for v1.1
export async function nirToCircuitJsonAsync(nir: Nir | unknown): Promise<AnyCircuitElement[]> {
  const version = detectNirSchemaVersion(nir)
  if (version === "v0.1-libbrecht") {
    return parseNirV01(nir as Nir)
  }
  return parseNirV11WithTscircuit(nir as unknown as NirV11)
}

// --------------------------------------------------------------------------- //
// End-to-end
// --------------------------------------------------------------------------- //

// Synchronous version (backward compat) - uses sync fallback for v1.1
export function serializeNir(nir: Nir | unknown): SerializerOutput {
  const circuitJson = nirToCircuitJson(nir)
  const { svg, viewerUsed } = renderCircuitJson(circuitJson)
  return { circuitJson, svg, viewerUsed }
}

// Async version that uses tscircuit for v1.1 (auto-place + auto-route)
export async function serializeNirAsync(nir: Nir | unknown): Promise<SerializerOutput> {
  const circuitJson = await nirToCircuitJsonAsync(nir)
  const { svg, viewerUsed } = renderCircuitJson(circuitJson)
  const hasPcbBoard = circuitJson.some((e: any) => e.type === "pcb_board")
  const centered = hasPcbBoard ? centerPcbLayout(circuitJson) : circuitJson
  const deduped = hasPcbBoard ? removeZeroLengthSegments(centered) : centered
  const merged = hasPcbBoard ? mergeCollinearSegments(deduped) : deduped
  // Chamfer BEFORE clearance enforcement: chamfering introduces new 45-degree
  // segments at former Manhattan corners, and enforceTracePadClearance needs
  // to see the geometry that actually ships (chamfered), not the
  // pre-chamfer Manhattan routing, or pad clearance around those new
  // diagonal segments is never checked.
  const chamfered = hasPcbBoard ? chamferCircuitJsonTracesTo45Degree(merged) : merged
  const cleared = hasPcbBoard ? enforceTracePadClearance(chamfered) : chamfered
  const kicadPcb = hasPcbBoard ? circuitJsonToKicadPcb(cleared) : undefined
  return { circuitJson: cleared, svg, viewerUsed, kicadPcb }
}

export { serializeNir as serializeNirSync }