# PCB Layout Module — Progress Report

**Module:** Layer 3 PCB Layout Generation
**Scope:** `~/my-project/layer_three/serializer/` — NIR → Circuit JSON → Autorouted KiCad `.kicad_pcb`
**Project:** Serializer (serializer)
**Author:** Sada Chouhan (Sada2108)
**Date:** 2026-07-27

---

## 1. Overview

The PCB layout module converts NIR (Neutral Intermediate Representation) circuit descriptions into production-ready KiCad `.kicad_pcb` files with fully routed copper traces. It sits within the Layer 3 serialization pipeline, downstream of the tscircuit CircuitRunner auto-placement stage and upstream of optional DRC validation via `kicad-cli`.

**Pipeline position:**

```
NIR v1.1 JSON
  → generateTscircuitJsx() → CircuitRunner → Circuit JSON
  → synthesizePcbPortsAndPads()     ← pcbRouting.ts (NEW)
  → routeCircuitJson()              ← pcbRouting.ts → router.ts → capacity-autorouter
  → snapCircuitJsonTracesToManhattan()
  → enforceTracePadClearance()
  → circuitJsonToKicadPcb()         ← kicadPcbWriter.ts
  → .kicad_pcb file
```

**Key decision: full routing, not ratsnest.** The module targets complete copper trace routing (all nets connected with physical trace segments), not KiCad ratsnest (airwires requiring manual routing). This was a deliberate architectural choice to produce fabrication-ready output.

**Autorouter selection:** `@tscircuit/capacity-autorouter` v0.0.692 (CapacityMeshSolver), wrapped in `router.ts` at `effort: 1` for speed. The solver operates on a mesh-based spatial representation of obstacles and connection points, producing SimplifiedPcbTrace wire/via segments that are snapped to Manhattan geometry before KiCad emission.

---

## 2. Timeline

All PCB layout work was committed in a single checkpoint commit, with subsequent bug fixes applied as uncommitted local changes.

| Date | Commit/Event | Description |
|------|-------------|-------------|
| 2026-07-09 | `03d9f9e` | Initial Layer 3 serializer: NIR → Circuit JSON → SVG. No PCB output. |
| 2026-07-16 | `68d461f` | SOIC-8 footprint added, pin name fixes. |
| 2026-07-17 | `a033682` | Guard `circuitJsonToKicadPcb` behind `pcb_board` presence check (prevents crash on v0.1 NIRs). |
| 2026-07-25 | `b0da82b` | **Major checkpoint.** kicadPcbWriter.ts (535 lines), pcbRouting.ts (475 lines), router.ts (173 lines) added. Full autorouting pipeline, KiCad 10 format writer, placement clearance, Manhattan snap, trace-pad clearance. Schematic-symbols migration also included. |
| 2026-07-26 | `3936430`, `fe1af18` | Remove generated PCB/DRC artifact files from git tracking. |
| 2026-07-27 | *uncommitted* | 4 critical bug fixes: autorouter bounds computation, NIR position override for footprints/board outline, trace net mapping. DRC achieves 0 violations on rc_lowpass fixture. |

### Architecture Decisions

1. **Full routing vs ratsnest:** Full routing chosen to produce fab-ready output. Ratsnest would require manual KiCad interaction.
2. **Autorouter: CapacityMeshSolver** selected over alternatives for its deterministic mesh-based approach and compatibility with the tscircuit ecosystem.
3. **KiCad 10 format:** `(version 20260206)` with `(generator_version "10.0")` targeting `kicad-cli` v10.0.4 installed on the development machine.
4. **DRC gate:** `kicad-cli pcb drc` invoked as a subprocess. No automated CI integration — DRC runs are manual via CLI.
5. **Footprint resolution:** Two-tier approach — real `.kicad_mod` files from the KiCad library (parsed via custom S-expression parser), with `PAD_TEMPLATES` as fallback when the library is unavailable.
6. **NIR positions override CircuitRunner placement:** CircuitRunner auto-places components at arbitrary positions; the KiCad writer always prefers NIR-specified `position.x_mm`/`position.y_mm` for deterministic, reproducible layouts.

---

## 3. Current Implementation

### 3.1 router.ts (174 lines)

Thin wrapper around `@tscircuit/capacity-autorouter` `CapacityMeshSolver`.

- **Input:** `SimpleRouteJson` (obstacles, connections, bounds, layer count, trace width constraints)
- **Solver config:** `{ effort: 1 }` — minimum effort for fastest solve
- **Output:** `RouteCircuitResult` with `RoutedTrace[]` — arrays of wire/via route segments
- **Manhattan snap:** `snapRouteToManhattan()` splits diagonal wire segments into horizontal-first L-shaped orthogonal pairs before returning results
- **Error handling:** Catches solver exceptions and returns `success: false` with error message

**Solver dependency:** `@tscircuit/capacity-autorouter@0.0.692` — pinned version. The solver's `getOutputSimplifiedPcbTraces()` throws `"Cannot get output before solving is complete"` if called prematurely or with malformed input (bounds containing NaN, obstacles at origin, etc.).

### 3.2 kicadPcbWriter.ts (1,171 lines)

Converts Circuit JSON to KiCad 10 `.kicad_pcb` S-expression format.

**Key subsystems:**

- **S-expression parser** (`parseSExpr`): Parses `.kicad_mod` footprint files from the KiCad library. Handles nested lists, quoted atoms, and multi-line expressions.
- **Footprint library resolver** (`resolveFootprintData`): Searches platform-specific KiCad footprint paths (`/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints/` on macOS, standard Linux paths). Returns `FootprintData` with parsed pads, graphics, and property texts.
- **Net assignment** (`applyPadsNetAssignments`): Maps pads to nets via `pcb_smtpad → pcb_port → source_port → source_trace → source_net` chain. Falls back to `source_port` → `source_trace` mapping when `pcb_smtpad` is absent.
- **Fallback templates** (`PAD_TEMPLATES`): Hardcoded pad geometry for 10 footprint types (0603, 0402, 1206, SOIC-8, MSOP-8, SOT-23-5, TSOT-23-5, 1x02 pin header) used when the KiCad library is unavailable.
- **Board outline** (`buildBoardOutline`): Computes bounding box from NIR-specified component positions + NIR `board_spec` dimensions, with 3mm margin. Centers the board around the component centroid.
- **Reference designator placement:** ICs (>4 pads): centered text at (0,0). Passives: perpendicular to pad axis with collision-aware fallback to center.
- **Trace segment emission** (`buildTraceSegments`): Converts `pcb_trace` route arrays into KiCad `(segment ...)` and `(via ...)` entries. Detects implicit layer changes and emits vias at transition points. Deduplicates vias by normalized position+layer key.
- **Net declarations** (`buildNetSection`): Emits `(net N "name")` and `(net_class "Default" "" (add_net "name") ...)` blocks — the latter is required or KiCad silently discards net declarations.

**Output format:**
```
(kicad_pcb (version 20260206) (generator "my-project")
  (generator_version "10.0")
  (general ...)
  (layers ...)
  (setup ...)
  (net 0 "")
  (net 1 "VIN")
  ...
  (net_class "Default" "" (add_net "VIN") ...)
  (gr_line ...) ← board outline on Edge.Cuts
  (footprint "..." (at X Y R) ...) ← with pads, graphics, properties
  (segment (start X Y) (end X Y) (width 0.2) (layer "F.Cu") (net N))
  (via (at X Y) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net N))
)
```

### 3.3 pcbRouting.ts (630 lines)

Routing utilities — the bridge between Circuit JSON and the autorouter.

- **`synthesizePcbPortsAndPads`**: Generates `pcb_port` and `pcb_smtpad` elements from NIR component positions + footprint pad data. Applies CW rotation transform for footprint-local → world coordinates. Required because CircuitRunner auto-placement does not produce these elements.
- **`circuitJsonToSimpleRouteJson`**: Converts Circuit JSON to `SimpleRouteJson` — maps `pcb_component` to obstacles, `source_net` to connections (grouping ports by net), and computes bounds from obstacle/connection extents + 5mm margin. Pad-level obstacles include 0.4mm clearance margin.
- **`mergeRoutedTraces`**: Replaces placeholder `pcb_trace` entries with real routed traces. Resolves net names by matching the first wire segment's coordinates against connection point positions.
- **`enforcePlacementClearance`**: Nudges overlapping `pcb_component` elements apart along the axis of minimum overlap, enforcing 0.5mm courtyard clearance.
- **`routeCircuitJson`**: End-to-end pipeline — placement clearance → SimpleRouteJson → solver → merge.
- **`snapCircuitJsonTracesToManhattan`**: Post-route Manhattan snap — splits diagonal wires into orthogonal L-shapes.
- **`enforceTracePadClearance`**: Pushes traces away from other-net pads by 0.25mm (0.2mm clearance + 0.05mm solder mask expansion).

### 3.4 _gen_pcb.ts (30 lines)

CLI entry point: `bun run _gen_pcb.ts [fixture_name]`

Full pipeline: serialize → synthesize ports/pads → route → Manhattan snap → pad clearance → KiCad emit → write file.

---

## 4. Status

### PCB Layout Steps

The PCB layout pipeline can be decomposed into the following functional steps. Each maps to a concrete implementation in the codebase.

| Step | Description | Status | Implementation |
|------|-------------|--------|----------------|
| **1. Circuit JSON → SimpleRouteJson** | Convert Circuit JSON (obstacles, connection points, bounds) to autorouter input format | **Complete** | `pcbRouting.ts:circuitJsonToSimpleRouteJson` |
| **2. Placement clearance enforcement** | Detect and nudge overlapping components apart before routing | **Complete** | `pcbRouting.ts:enforcePlacementClearance` |
| **3. Autorouter execution** | Run CapacityMeshSolver to produce routed trace segments | **Complete** | `router.ts:routeCircuit` |
| **4. Manhattan snap + trace-pad clearance** | Orthogonalize traces, push away from other-net pads | **Complete** | `pcbRouting.ts:snapCircuitJsonTracesToManhattan`, `enforceTracePadClearance` |
| **5. KiCad PCB emission** | Generate `.kicad_pcb` S-expression with footprints, pads, traces, vias, nets, board outline | **Complete** | `kicadPcbWriter.ts:circuitJsonToKicadPcb` |
| **6. Real footprint library integration** | Parse `.kicad_mod` files from KiCad library; fallback to PAD_TEMPLATES | **Complete** | `kicadPcbWriter.ts:resolveFootprintData`, `parseKicadMod` |
| **7. DRC validation gate** | Run `kicad-cli pcb drc` and verify 0 violations, 0 unconnected items | **Complete** (manual) | `kicad-cli pcb drc <file> --format json` |

### DRC Run Status

**Fixture:** `rc_lowpass` (R1 + C1, 3 nets: VIN, VOUT, GND)

```
$ kicad-cli pcb drc _rc_lowpass.kicad_pcb -o /tmp/drc_out.json --format json
Found 0 violations
Found 0 unconnected items
```

All 3 nets fully routed. 0 errors, 0 warnings, 0 unconnected items. Board outline encloses all traces with sufficient edge clearance.

**Fixture:** `opamp_noninv` (OPA344 + R1-R5, C1-C4, 11 components) — validated through the real `serializeNirAsync` path (CircuitRunner autorouting in/out, NOT `_gen_pcb.ts` re-route).

```
$ kicad-cli pcb drc _opamp_real.kicad_pcb -o /tmp/opamp_real.json --format json
Found 3 violations (all silk_over_copper: R3/R4/R5 VREF reference field clipped by solder mask)
Found 0 unconnected items
```

All 13 nets fully routed. The 3 silk_over_copper entries are silkscreen-over-pad warnings (0402 passives packed in a row) — matches the historical pre-migration baseline exactly and is not a routing error.

**Root cause of earlier high opamp counts (152 via `_gen_pcb.ts`, 15 via `serializeNirAsync`):** `mergeCollinearSegments` (serializer/pcbRouting.ts) used a pairwise same-axis merge that silently deleted legitimate route pivots (e.g. rc_lowpass GND's diagonal-then-vertical bend became a phantom straight diagonal clipping the VIN pad, and VIN/VOUT start points were absorbed into degenerate/stub traces). Fixed 2026-08-10 with a true three-point cross-product collinearity test (`COLLINEAR_EPSILON = 1e-6`). Post-fix baselines: rc_lowpass 0/0, opamp 3 warnings/0 unconnected.

### Test Status

```
102 pass, 0 fail across 6 test files (3164 expect() calls)
```

**PCB-specific test coverage:**

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `kicadPcbWriter.test.ts` | 13 | Output structure, net declarations, footprint blocks, pad rotation regression, net-to-net short detection |
| `pcbRouting.test.ts` | 8 | SimpleRouteJson shape, obstacle mapping, connection mapping, routeCircuitJson e2e, mergeRoutedTraces, enforcePlacementClearance |
| `router.test.ts` | 4 | Successful routing, graceful failure, Manhattan orthogonality, same-layer crossing detection |

---

## 5. Open Issues / Blockers

### 5.1 kicad-cli Version String Compatibility

The writer emits `(version 20260206)` and `(generator_version "10.0")`, which matches the installed `kicad-cli` v10.0.4. No parsing or DRC failures have been observed with this version combination.

**Status:** No active issue. The version string was aligned during development. If KiCad upgrades the expected version number, the writer's hardcoded strings at `kicadPcbWriter.ts:1141-1142` would need updating.

### 5.2 Untracked Files — No Git History for PCB Module

All PCB layout files were added in commit `b0da82b` (2026-07-25) as part of a large checkpoint commit, then subsequently untracked in `3936430` and `fe1af18`. The critical bug fixes from 2026-07-27 (bounds computation, NIR position override, trace net mapping) are **not yet committed**. This makes it impossible to reconstruct the development timeline of individual bug fixes via `git log`.

**Action required:** Commit the current state of `serializer/kicadPcbWriter.ts`, `serializer/pcbRouting.ts`, `serializer/router.ts`, `kicadPcbWriter.test.ts`, `pcbRouting.test.ts`, `router.test.ts`, and `_gen_pcb.ts`.

### 5.3 DRC Is Manual — No Automated Gate

DRC validation requires running `kicad-cli pcb drc` as a separate manual step. There is no integration into the test suite or CI pipeline. The `kicad-cli` binary must be installed on the development machine.

### 5.4 Only Two Small Fixtures Validated for Full Routing

The `rc_lowpass` fixture (2 passives, 3 nets) has been fully validated through the routing pipeline with clean DRC. The `opamp_noninv` fixture (11 components, 13 nets) has also been validated — through the real `serializeNirAsync` path (`_gen_pcb_real.ts` → `kicad-cli pcb drc`) — at 3 silk_over_copper warnings, 0 unconnected. Both validations postdate the `mergeCollinearSegments` root-cause fix (2026-08-10) that eliminated the phantom-diagonal/degenerate-trace corruption, so these numbers reflect the actual production path (CircuitRunner autorouting), not the `_gen_pcb.ts` re-route pipeline. **Neither of these fixtures is representative of a dense, real-world board — see §5.5.**

### 5.5 `astracomputer` DRC Findings (2026-08-24) — Large Fixture, Real Violations

The `astracomputer` fixture (a 4-layer, ~85×42mm avionics board with well over 100 components) was, until now, never run through `kicad-cli pcb drc` against the real `serializeNirAsync`/`render_pcb_viewer.ts` output. Doing so for the first time surfaced a large, previously-undocumented violation count that has nothing to do with the small validated fixtures above:

```
$ kicad-cli pcb drc astracomputer.kicad_pcb -o drc.json --format json --severity-all
Found 1174 violations   (before this session's fixes)
Found 1171 violations   (after)
Found 1 unconnected items
```

Category breakdown (before → after this session's fixes):

| Category | Before | After | Notes |
|---|---|---|---|
| clearance | 500 | 500 | Trace-to-pad/trace-to-trace, mostly autorouter density |
| shorting_items | 199 | 199 | **Real electrical shorts** between different nets — different-net tracks/vias touching or crossing |
| hole_clearance | 199 | 201 | Run-to-run noise (autorouter is not fully deterministic); not from this session's changes |
| solder_mask_bridge | 70 | 69 | |
| hole_to_hole | 68 | 62 | |
| tracks_crossing | 48 | 60 | Run-to-run noise, same as hole_clearance |
| silk_over_copper | 38 | 38 | Reference text clipped by a pad's solder mask — unrelated to the ref-vs-ref fix below |
| via_dangling | 19 | 20 | |
| drill_out_of_range | 12 | 12 | |
| holes_co_located | 10 | 7 | **Partially fixed** — see below |
| **silk_overlap** | **8** | **0** | **Fully fixed** — see below |
| silk_edge_clearance | 2 | 2 | Ref text (R43/R44) clipped by the board edge — a placement-margin issue, not addressed |
| track_dangling | 1 | 1 | |

**What this session actually fixed, and verified against real DRC:**

1. **Silkscreen-vs-silkscreen collisions (item 4, the R17–R51 cluster): fixed, 8 → 0.** `buildFootprintBlocks` in `kicadPcbWriter.ts` chose each reference-text position by checking for collisions against neighboring component bodies and pads only — never against *other components' already-placed reference text*. In a tightly packed resistor cluster, two neighbors could each independently pick a ref position that dodges bodies/pads but lands on top of each other's ref text. Fixed by tracking placed ref-text bounding boxes and checking new candidates against them too.
2. **Duplicate/co-located vias: improved, 10 → 7.** Two independent trace routes for the same net could each emit a via at what is physically the same point but differs in the 4th decimal place from floating-point drift, evading the old exact-string dedup key. Rounded the dedup key to a 0.05mm grid (well under a via's own 0.6mm diameter) and added the net to the key (it was previously missing, which was also a latent correctness gap). The remaining 7 are exact-zero-distance duplicates from a different, not-yet-diagnosed source and need further investigation.
3. **Clearance-blind-to-diagonals (item 2's specifically-flagged issue): fixed and reordered.** `chamferCircuitJsonTracesTo45Degree` previously ran *after* `enforceTracePadClearance` in `serializeNirAsync`, so the 45° corner segments it introduces were never checked against pad clearance. Reordered so chamfering happens first, and generalized `enforceTracePadClearance`'s push logic (previously Manhattan-only, skipping any non-axis-aligned segment outright) to cover diagonal segments too. Verified no regression: `rc_lowpass` stays 0/0 and `opamp_noninv` stays at its documented 3 silk_over_copper baseline.

**What's still open, and why it's out of scope for a quick fix:** the dominant categories — `clearance` (500), `shorting_items` (199), `hole_clearance` (~200), `tracks_crossing` (~50-60) — did not move with the writer-level fixes above, and category counts fluctuate slightly between identical re-runs of the same fixture. This points to the underlying autorouter (`@tscircuit/capacity-autorouter` via `router.ts`) producing genuine net-to-net crossings and insufficient clearance when routing a board this dense, not a bug in the KiCad-emission or clearance-enforcement code. `enforceTracePadClearance` only ever checked trace-vs-*pad* clearance — it has no trace-vs-trace (different net) check at all, so it structurally cannot catch `shorting_items`/`tracks_crossing`. Closing this gap needs either a larger board / lower component density, a real trace-vs-trace clearance pass, or improvements to the autorouter's collision handling — each a substantially bigger effort than this session's scope. The previously-documented "0 violations" claims in this report were never about `astracomputer` (they cover `rc_lowpass`/`opamp_noninv` only, both far smaller); this section is the first real data point for a dense board and should be treated as the current known baseline, not a regression.

### 5.6 ~~Single-Layer Routing~~ — Stale, Corrected 2026-08-24

**This claim was stale and is retracted.** It was accurate only for whatever fixtures had been tested when it was written — likely small 2-layer boards where a simple net never needed a via. It does **not** describe the real production path today: `pcbRouting.ts:circuitJsonToSimpleRouteJson` reads `layerCount` from `board.num_layers` (not hardcoded), and `astracomputer` (`board_spec.layers: 4`) already routes real traces and vias across all 4 copper layers — confirmed by grepping the generated `.kicad_pcb` for `(layer "...")` tokens: F.Cu, In1.Cu, In2.Cu, and B.Cu segment/via counts are all nonzero (roughly 1600/490/470/420 respectively for a recent run). The via-emission path in `kicadPcbWriter.ts` (via detection, layer-change bridging) is exercised in production, not dead code. See §5.7 for what this session actually changed and verified.

---

### 5.7 2026-08-24 Session: Multi-Layer Solver, Board Outline, Mounting Holes/Silkscreen

**Reference board located.** A real "Astra Computer V2" KiCad project (the one `astracomputer.nir.json` was extracted from) exists at `~/Downloads/Astra Computer V2/Astra Computer V2.kicad_pcb`. Ground truth confirmed from it:
- 4-layer stackup: `F.Cu` (signal) / `In1.Cu` (GND plane) / `In2.Cu` (PWR plane) / `B.Cu` (signal) — matches `board_spec._NEW_stackup_arrangement` exactly.
- Board outline: rounded rectangle, 42mm (x) × 85mm (y), 3mm corner radius, at absolute board coordinates x∈[120,162], y∈[44,129] — matches `_NEW_mechanical_constraints.board_outline` (`width_mm: 42`, `length_mm: 85`, `corner_radius_mm: 3`) exactly.
- 4x plated mounting holes (`MountingHole_2.7mm_M2.5`) near the board corners — matches `_NEW_mechanical_constraints.mounting_holes` (MH1–MH4, 2.7mm diameter, M2.5) exactly, in the same absolute coordinate frame as the board outline above.
- Free-floating silkscreen graphics ("ASTRA" logo, "2S VIN", "PC1"–"PC5", "PROG1", pin labels): manually placed `gr_text` elements in the real `.kicad_pcb`, not tied to any component or net.

**1. Multi-layer routing: upgraded the solver in `router.ts` — turned out to be dead code for this fixture (correction below).** `router.ts` used `CapacityMeshSolver` (`AutoroutingPipelineSolver2_PortPointPathing`), which the `@tscircuit/capacity-autorouter` package's own type definitions mark `@deprecated Use AutoroutingPipelineSolver instead`. Switched to `AutoroutingPipelineSolver` (`AutoroutingPipelineSolver7_MultiGraph`), a newer pipeline with DRC-aware repair stages (`GlobalDrcForceImproveSolver`, `HighDensityForceImproveSolver`, `GlobalDrcBranchPortfolioSolver`, none present in the deprecated pipeline). Drop-in API compatible (`new Solver(srj, opts)`, `.solve()`, `.getOutputSimplifiedPcbTraces()` all inherited from the same `BaseSolver`).
  - Result on `astracomputer`: DRC violations 1171 → 1154 (-17), mostly from `tracks_crossing` (51→43). Modest, not transformative.
  - **Tried increasing `effort` from 1 to 2 as a possible quality lever — this regressed badly** (the solver's internal repair loop hit "ran out of iterations" and aborted early, producing an incomplete ~142KB route set instead of the normal ~650KB). Reverted to `effort: 1`. This is not a free quality dial for this solver/fixture combination.
  - Verified no regression on the small fixtures: `rc_lowpass` stays 0/0, `opamp_noninv` stays at 3 silk_over_copper/0 unconnected.
  - **⚠️ Correction (2026-08-25 follow-up session): `router.ts`'s `routeCircuit`/`routeCircuitJson` is not called anywhere in `serializer.ts`.** It's only used by `_gen_pcb.ts` (already flagged elsewhere as a separate ad-hoc pipeline) and the unit tests. `astracomputer`'s actual production routing happens entirely inside `@tscircuit/core`'s own internal "capacity-mesh-autorouting" effect via `CircuitRunner` — which independently already uses `AutoroutingPipelineSolver` internally (confirmed: `grep -o "AutoroutingPipelineSolver[0-9_A-Za-z]*" node_modules/@tscircuit/core/dist/index.js` lists it). So the 1171→1154 change attributed to this solver swap did not actually come from it — it was very likely run-to-run nondeterminism in `@tscircuit/core`'s internal autorouter. The `router.ts` upgrade is still worth keeping (correct per the library's own deprecation notice, zero regression), but it has no bearing on `astracomputer`'s output. See §5.8 for the real investigation into what's actually in that code path.

**2. Board outline: root-caused, fix attempted, reverted after it broke routing.** `generateTscircuitJsx` (`serializer.ts`) sets `<board width height>` from `board_spec?.width ?? 80` / `board_spec?.height ?? 60` — but `board_spec` never actually carries width/height (it's stackup metadata: layers/material/thickness). Every fixture silently gets the 80×60mm fallback regardless of its real shape. The real dimensions (42×85mm) live in the separate, untyped `_NEW_mechanical_constraints.board_outline` field and were never read.
  - Wired `board_outline.width_mm`/`length_mm`/`corner_radius_mm` into the `<board>` JSX (`width`, `height`, `borderRadius` props — `tscircuit`'s `BoardProps.borderRadius` supports exactly this).
  - **This broke astracomputer's routing.** Shrinking/reshaping the virtual board from 80×60mm (4800mm²) to the real 42×85mm (3570mm², and much narrower) caused tscircuit's default auto-placement — which does not itself pack to fit a given board shape — to no longer fit its 100+ components within the router's bounds. `AutoroutingPipelineSolver` aborted with "ran out of iterations" within ~30s instead of producing a route (confirmed: reverting the dimension change alone restored the normal ~4min successful run).
  - **Reverted** to the 80×60mm fallback. The board outline our pipeline draws is confirmed to already be a single, clean `gr_rect` (not multiple/jagged Edge.Cuts entries) — so "irregular" in the visual comparison against the reference is about aspect-ratio/size mismatch and dense routing appearance, not a malformed outline shape.
  - **Real fix needs a placement-density pass**: something that packs components to actually fit a given board footprint before/during autorouting, independent of this session's scope. Do not re-attempt the metadata-plumbing fix alone without that — it will reproduce the same routing failure.

**3. Mounting holes and silkscreen branding: investigated, not implemented — blocked by the same root cause as #2.** The 4 mounting holes are real data (not fabricated) but their coordinates (e.g. MH1 at x=159, y=126) are only meaningful in the *real* board's 42×85mm coordinate frame. Our synthetic board is a different shape (80×60mm) with independently auto-placed components, so transplanting the real coordinates would place holes at arbitrary, likely wrong positions relative to our own layout — not a genuine fix, and worse than leaving them out. Adding them correctly requires #2's placement-density fix first. The silkscreen branding/labels ("ASTRA", "2S VIN", "PC1"-"PC5", etc.) have **no representation anywhere in the NIR schema** — confirmed by searching the fixture for any text/silk/logo/graphic field — so per the task's explicit instruction, nothing was fabricated here.

**Verification:** `bun test` — 149 pass, 0 fail (no new regressions from this session's changes). `rc_lowpass`/`opamp_noninv`/`instrumentation_amp` DRC unchanged from prior baselines. `astracomputer` DRC: 1154 violations (down from 1171 at the end of the prior session), board renders centered with the same 80×60mm rectangle as before (safe, unchanged) — see §5.5 for full category breakdown context.

**Calibration: DRC on the real reference board itself.** Ran `kicad-cli pcb drc` directly on `~/Downloads/Astra Computer V2/Astra Computer V2.kicad_pcb` (the real, professionally-laid-out board) to get a genuine "what does clean look like" baseline, rather than assuming 0 violations is the right bar for a board this complex:

```
Found 283 violations, 6 unconnected items   (real reference board)
Found 1154 violations, 1 unconnected item   (our astracomputer output)
```

| Category | Reference (real board) | Ours (astracomputer) |
|---|---|---|
| shorting_items | **0** | **199** |
| clearance | 43 | 501 |
| hole_clearance | 4 | 200 |
| lib_footprint_mismatch | 111 | 0 |
| malformed_courtyard | 37 | 0 |
| silk_overlap | 24 | 0 |

Two important takeaways from this comparison:
1. **The real board has zero `shorting_items` and an order of magnitude fewer `clearance`/`hole_clearance` violations.** This confirms our autorouter's same-layer, different-net crossings are a genuine quality gap — not DRC-ruleset noise or an unreasonable bar. A real board routed by a human at this density is not full of shorts; ours is.
2. **The reference board's own violation count (283) is not zero either**, dominated by `lib_footprint_mismatch` (111, stale footprint library links after a KiCad/library version bump — not a design defect) and `malformed_courtyard` (37, third-party footprint courtyard definitions, not something the designer controls). Neither category appears in our output at all, since we generate footprints programmatically rather than referencing an external library that can drift. So "0 violations" was never the realistic target for either board — the meaningful comparison is the shorting/clearance categories, where the gap is real and large.

---

### 5.8 2026-08-25 Follow-up: Fixed-Canvas Placement Investigation — Real Target Confirmed Infeasible

Direct follow-up task: make placement respect a fixed target board size/shape so the real 42×85mm outline can be used. Full investigation below, with numbers.

**Step 1 — where placement actually happens.** Neither `serializer.ts` nor `pcbRouting.ts` implements component placement. `parseNirV11WithTscircuit` (`serializer.ts`) generates tscircuit JSX and hands it to `@tscircuit/eval`'s `CircuitRunner`, which internally delegates PCB placement to **`calculate-packing`** (an `@tscircuit/core` dependency, `package.json` confirms it). Per that package's own README, the algorithm is a **greedy outline-growing bin-packer**, not a grid/force-directed layout:
1. sort components largest → smallest
2. pack the first component at the origin
3. compute the outline (union of inflated AABBs) of everything packed so far
4. probe outline points for the shortest distance to a same-network pad already placed
5. try all 4 orthogonal rotations at that point, pick the cheapest non-overlapping one
6. repeat until every component is placed

Critically: **this algorithm has no concept of reserving space for traces.** It packs bodies edge-to-edge (respecting only `minGap` clearance) and stops as soon as there's zero overlap — it does not know or care whether anything will fit a wire between the packed components afterward.

`calculate-packing`'s `PackInput` type does expose `bounds`/`boundaryOutline` fields, and **placement does respect a target board size**: reproduced directly (bypassing our own code, via `CircuitRunner` + a modified `board_spec.width/height`) — with a 42×85mm target, `astracomputer`'s 127 components packed into a **40.9×83.7mm bounding box**, i.e. it actually fit, using 97-98% of the available width/height. Placement was never the problem.

**What last session's "ran out of iterations" report actually was:** reproduced directly this session. With the true 42×85mm target, `@tscircuit/core`'s internal `PcbTraceRender` "capacity-mesh-autorouting" effect throws:
```
AutorouterError: Static reachability precheck failed: 7 route(s) have no legal path under
the current reservation and start-region rules source_net_92 (...), source_net_70_mst0 (...),
source_net_57 (...), source_net_41 (...), source_net_18 (...), +2 more
```
This is a **deterministic, upfront feasibility check** — not a timeout or retry-budget issue — that runs before the solver attempts to route anything, and the same named nets fail it every time. `@tscircuit/core` catches this internally as an "Async effect error" rather than propagating it, so the caller (our code) just receives a normal-looking `circuitJson` with `pcb_trace` elements present but **every route empty** (`traceCount: 319, routedCount: 0` in the reproduction) — a silently truncated result, exactly as suspected. (A different, related error — "vz ran out of iterations" — showed up at some *other* board sizes tested below; that one is a retry-budget exhaustion, not the deterministic precheck. Both produce the same 0-routes symptom.)

**Step 2 — sizing sweep.** Interpolated linearly from the current default (80×60mm) toward the real target (42×85mm) at t=0.2/0.4/0.6/0.8/1.0, `width = 80 - 38t`, `height = 60 + 25t`:

| t | size (mm) | area (mm²) | result |
|---|---|---|---|
| 0 | 80×60 | 4800 | ✅ 319/319 routed (known-good baseline) |
| 0.2 | 72.4×65 | 4706 | ✅ 319/319 routed |
| 0.4 | 64.8×70 | 4536 | ❌ 0/319 — "ran out of iterations" |
| 0.6 | 57.2×75 | 4290 | ✅ 317/319 routed (2 short) |
| 0.8 | 49.6×80 | 3968 | ❌ 0/319 — "ran out of iterations" |
| 1.0 | 42×85 (real target) | 3570 | ❌ 0/319 — "static reachability precheck failed" (deterministic) |

**This is not a clean monotonic threshold.** t=0.4 (4536mm²) fails while the *smaller* t=0.6 (4290mm²) mostly succeeds — success is sensitive to exactly how the board dimensions interact with the autorouter's internal capacity-mesh subdivision, not simply "is there enough room." This means there is no safe formula like "pick any board ≥ X mm²" — some sizes above the apparent threshold still fail.

**Isolating area vs. aspect ratio (two additional targeted tests, both explicitly at 3570mm² — the real target's exact area):**
- 42×85mm (real, narrow/portrait): ❌ 0/319, deterministic precheck failure (7 unroutable nets).
- 68.99×51.74mm (same 3570mm² area, but the *current working* 80:60 landscape aspect ratio): ❌ 0/319, **the same** deterministic precheck failure (4 unroutable nets, overlapping the same net names as the 42×85 case: `source_net_92`, `source_net_57`, `source_net_41`).

**Conclusion: it's area, not shape.** 3570mm² is reproducibly too small for this pipeline to route 127 components regardless of aspect ratio. A further attempt at a portrait-shaped 55×85mm board (4675mm² — an area in the range where 4290-4800mm² had succeeded before) *also* failed ("ran out of iterations"), reinforcing that success at this component density is fragile and size-sensitive across a fairly wide range, not just below one clean cutoff.

**Also tried: `autorouterEffortLevel="5x"` on `<board>`** (a `SubcircuitGroupProps`/`BoardProps` prop distinct from the low-level solver `effort` parameter tested last session) at the real 42×85mm target — **no effect**, identical deterministic precheck failure, same net names. Confirms this specific failure is a feasibility precheck, not something a bigger compute/retry budget can route around.

**Numbers requested by the task, stated explicitly:** 127 placed components (2 of which — J2, U7 — additionally fail to even instantiate due to an unrelated pre-existing `pinLabels` prop-validation bug, confirmed present regardless of board size; see below) need in the neighborhood of **4300-4800mm²** to route reliably with the current `@tscircuit/core`/`calculate-packing`/`@tscircuit/capacity-autorouter` pipeline (and even within that range, specific dimensions can still fail). The real board's target is **3570mm²** — about 25-34% smaller than the smallest size that worked in this sweep. **Full 42×85mm packing is confirmed infeasible without a placement algorithm that reserves routing-channel space, which `calculate-packing`'s greedy edge-to-edge bin-packer does not do.** This is a rewrite of an external dependency's placement strategy, not something fixable by board-size tuning, JSX props, or our own `serializer.ts`/`pcbRouting.ts`/`kicadPcbWriter.ts` code — out of scope for this task. Per the task's own instructions, Steps 3 and 4 (wiring in the real outline, adding mounting holes) were **not attempted**, since doing so would ship a silently-broken board.

**Separate, pre-existing bug found in passing (not fixed, out of scope for this task):** `J2` (USB-C receptacle) and `U7` fail to instantiate as tscircuit chip components at *every* board size tested, including the working 80×60mm default (`source_failed_to_create_component_error`, "Invalid props for chip... pinLabels"). Root cause looks like alphanumeric pin identifiers (J2's USB-C pins are named `A1`-`A12`/`B1`-`B12`/`S1`, generating JSX prop keys like `pinA1: "A1"`) not matching whatever `pin<N>`-style key format `@tscircuit/core`'s `pinLabels` prop schema expects. This silently drops J2 and U7 from the board entirely (confirmed: 65 error elements including several `source_trace_not_connected_error` for their pins) — unrelated to board sizing, present before this investigation, and outside this task's scope. Worth its own follow-up.

**What was actually implemented this session (safe, verified, no board-size change):** `assertRoutingCompleted()` in `serializer.ts`, called from `parseNirV11WithTscircuit` right after `CircuitRunner` returns. Detects the exact failure signature reproduced above — `pcb_trace` elements present, netlist requires routing, but zero traces have a non-empty route — and throws a specific, actionable error (board dimensions, area, component count, net count) instead of silently returning/shipping the truncated result. Verified as a no-op on the known-good path (astracomputer default 80×60mm still completes normally, ~650KB output) and covered by 4 new fast unit tests in `serializer.test.ts` (`describe("assertRoutingCompleted", ...)`, synthetic fixtures, no real `CircuitRunner` invocation — run in milliseconds).

**Board size actually shipped:** unchanged, 80×60mm fallback (same as before this session). The real 42×85mm target was not adopted — confirmed infeasible per above.

**Verification:** `bun test` — 153 pass, 0 fail (149 prior + 4 new `assertRoutingCompleted` tests). `rc_lowpass` DRC 0/0, `opamp_noninv` DRC 3/0 unconnected — both unchanged from prior baseline. `astracomputer` at the (unchanged) 80×60mm default still produces the full ~650KB output with real routing, confirmed by direct regeneration this session.

---

### 5.9 2026-08-24 Follow-up: J2/U7 `pinLabels` Instantiation Bug — Fixed

Root-caused and fixed the bug flagged in §5.8/Next-Steps item 11. Confirmed directly against `@tscircuit/core`'s source (`node_modules/@tscircuit/core/dist/index.js`): the `Chip` constructor explicitly validates every `pinLabels` key against `PIN_LABELS_KEY_RE = /^(?:pin)?(\d+)$/` and throws `InvalidProps` — `"Invalid pinLabels key \"pinA1\". Expected \"pin${number}\" (e.g. pin1, pin2)."` — for any key that doesn't match. `generateComponentJsx` (`serializer.ts`) was building keys directly from the NIR's `pin_number` field (`pin${physPin}`), which is not always numeric: J2 (USB-C) uses J-STD alphanumeric pin identifiers (`A1`-`A12`, `B1`-`B12`, `S1`) as its real KiCad pad numbers, and U7 (a BGA-style GPS module, `MIA-M10Q-00B`) uses grid pin identifiers (`A1`, `H9`, `J4`, ...) via its `custom_footprint_pads`.

**Fix:** `pinLabels` keys are now always a valid `pin<N>` slot — numeric `pin_number`s keep their real number as before; non-numeric ones get an arbitrary sequential fallback integer instead. The pin's real identity (`"A1"`, `"H9"`, etc.) is unaffected and continues to live in the `pinLabels` *value*, which is what trace references (`<trace from="J2.A1" .../>`) and footprint pad matching (`portHints={["A1"]}`) actually resolve against — confirmed this stays intact by inspecting the generated JSX directly.

**Verified fixed, both symptoms gone:** a direct `serializeNirAsync(astraComputerNir)` regeneration now shows `source_failed_to_create_component_error` count **0** (was throwing for J2/U7 before) and `source_trace_not_connected_error` count **0** (was cascading errors for their pins). Both `J2` and `U7` now appear as proper `source_component`/`pcb_component` entries — `pcb_component` count is **129** (127 + J2 + U7, exactly as expected). Added 2 fast, deterministic unit tests (`describe("generateTscircuitJsx pinLabels key format", ...)` in `serializer.test.ts`) that assert every chip's `pinLabels` keys match `PIN_LABELS_KEY_RE` and that the real alphanumeric identifiers survive as values — these run in milliseconds and don't depend on the real (flaky, multi-minute) `CircuitRunner`/autorouter pipeline.

**Important side effect, not a regression in this fix — a pre-existing limitation now visible:** J2 and U7 add 47 pins' worth of new nets to route (13 + 34) on top of the already-dense 127-component board. §5.8 already established that this exact fixture's routing is fragile and non-monotonic in the 4290-4800mm² range at the current 80×60mm (4800mm²) default. Post-fix, a `kicad-cli pcb drc` run against the regenerated board found **317 unconnected items** (up from the pre-fix baseline of 1 in §5.5/§5.7) — but only 30 of those 317 (9 involving J2, 21 involving U7) are attributable to the newly-instantiated components; the remaining ~90% are pre-existing nets elsewhere on the board that lost their routing headroom now that J2/U7 compete for the same limited capacity. A second identical regeneration run produced an even worse result — zero `pcb_trace` elements at all (total autorouter failure, `AutorouterError: vz ran out of iterations`) — confirming §5.8's own finding that this pipeline is non-deterministic and fragile near its capacity ceiling, not something this fix destabilized. **Net effect: the instantiation bug is fixed and verified (this task's actual scope), but it surfaces — rather than causes — the pre-existing routing-capacity ceiling from §5.8 at a slightly lower margin.** Per the task's explicit instruction, `board_spec` dimensions were not touched to compensate; that remains the placement-density work scoped out in §5.8/Next-Steps item 9.

**Gap noticed in passing (not fixed, out of scope for this task):** `assertRoutingCompleted()` (§5.8) only detects "`pcb_trace` elements present but every route empty." The total-autorouter-failure case observed above — zero `pcb_trace` elements generated at all when the netlist requires routing — takes the function's `if (traces.length === 0) return` early-out, which is designed for the legitimate "nothing needed routing" case but also silently passes this worse failure mode through unflagged. Worth a follow-up fix: distinguish "no traces because nothing needed routing" from "no traces because the netlist needed routing and got none."

**Verification:** `bun test` — 155 pass, 1 unrelated pre-existing failure (`dev-tools/scaleMatrix.test.ts`, "Chrome CDP did not start" — a local headless-Chrome-availability flake, not exercised by or related to this change). All serializer/PCB tests pass, including the 2 new pinLabels tests.

---

### 5.10 2026-08-25 Follow-up: Board-Size Decision Superseded — J2 Itself Blocks Routing at Every Size Tested

**Bottom line: this task's "Option A" board-size decision (57.2×75mm or the 72.4×65mm fallback) could not be executed as planned.** Re-testing those candidates with §5.9's J2/U7 fix applied — necessary, since J2/U7 previously being silently dropped meant they weren't part of any prior routing test — found that **J2's presence alone breaks routing, independent of board size.** This is new information that invalidates the premise the size decision was made on, not a re-litigation of the decision itself.

**What was tested (all with J2 correctly instantiated, per §5.9):**

| Board size | Area | Result |
|---|---|---|
| 57.2×75mm | 4290mm² | ❌ 0/N routed, "ran out of iterations" |
| 60×78mm | 4680mm² | ❌ 0/N routed, "ran out of iterations" |
| 62×80mm | 4960mm² | ❌ 0/N routed, "ran out of iterations" |
| 72.4×65mm (the safe fallback) | 4706mm² | ❌ 0/N routed, "ran out of iterations" |
| 80×60mm (current shipped default) | 4800mm² | ❌ 0/N routed, "ran out of iterations" |
| 90×70mm | 6300mm² | ❌ 0/N routed, "ran out of iterations" |
| 100×80mm | 8000mm² | ❌ 0/N routed, "ran out of iterations" |

Every size failed, including sizes far larger than anything in §5.8's original (pre-J2-fix) sweep. **Isolation test: removing only J2 (keeping U7 and everything else) at the original 80×60mm size routed 352/352 traces successfully** — conclusive proof the blocker is J2 specifically, not board area.

**Root cause, confirmed against the real reference board:** J2's actual KiCad footprint (`Connector_USB/USB_C_Receptacle_Palconn_UTC16-G`) places its reversible-connector mirror pins (A1/B12, A4/B9, A9/B4, A12/B1 — all same-net pairs, by design, so a USB-C cable works either way up) at **literally identical physical coordinates** — confirmed directly in the reference `.kicad_pcb`: A1 and B12 both sit at `(at -3.2 -2.51 270)`. `@tscircuit/core`'s internal autorouter generates a solid, inflated obstacle at every pad regardless of net; two fully-coincident obstacles at the same point create a degenerate local geometry its pathfinding cannot route around, and this appears to poison routing for the whole board rather than failing gracefully for just that local area.

**Mitigation attempted, insufficient alone:** added a connector-scoped dedup in `generateTscircuitJsx` (`serializer.ts`) — for `component_type === "connector"` only (NOT ICs — U7 alone has 27 same-ref-same-net pin pairs that are genuinely separate physical pins needing independent routes, e.g. multiple real GND balls on a BGA; blindly deduping those would silently drop real connectivity), only the first pin per (component, net) gets an explicit `<trace>`. This removes real per-pin redundancy but **did not fix routing on its own** — re-tested directly, 80×60mm still fails identically after this fix. The obstacle-geometry problem is independent of how many traces reference the coincident pads. A second experiment nudging J2's mirror pads apart by a ~0.001mm epsilon (via a custom inline footprint) changed the failure mode (an actual route was attempted instead of an immediate precheck rejection) but surfaced new pad-to-pad and trace-to-pad clearance violations from the connector's own very tight real pitch — incomplete, not pursued further given time, and not applied to the shipped code.

**A real, separate bug fixed along the way:** `assertRoutingCompleted()` (added in §5.8, flagged as an open gap in §5.9) only checked "`pcb_trace` elements present but every route empty." Confirmed directly: total autorouter failure can produce **zero `pcb_trace` elements at all**, which took the function's `if (traces.length === 0) return` early-out and silently passed the worst failure case through unflagged — exactly the gap §5.9 predicted. Fixed: that early-out is removed, so "netlist needs routing but zero trace elements exist" is now correctly treated as the same failure as "traces exist but none are routed." Verified: this newly-strict check correctly caught a **second, unrelated pre-existing routing failure** in the `layer2mockschema` test fixture (3 components, 1 net) that the old buggy check had been silently letting through the whole time — updated the corresponding unit test to document this rather than mask it (`serializer.test.ts`).

**Practical consequence:** `serializeNirAsync(astraComputerNir)` now **throws** at every board size tested, rather than silently shipping the previously-observed truncated/traceless `.kicad_pcb`. This is the intended, correct behavior of `assertRoutingCompleted` — but it means **no fully-routed astracomputer `.kicad_pcb` could be produced or DRC'd this session** with J2 correctly included. The last successful full DRC numbers for astracomputer (1154 violations) are from §5.7/§5.9, predating the J2/U7 correctness fix, and are **not reproducible now** given the same fixture with J2 correctly wired.

**What was NOT attempted, and why:** silently excluding J2 from the routing path (e.g. reverting the dedup to a full drop) to force a "successful" render was explicitly avoided — that would mean the routed board again ships without J2 wired, the exact silent-drop bug this session fixed. Shipping a `board_spec` change to force success was also avoided, since every tested size — up to 100×80mm — failed identically; there is no board-size lever left to pull.

**Mounting holes:** not implemented. Blocked transitively — no board size in this session's testing produced a working routed board to add them to, and the underlying board-outline/coordinate-frame blocker from §5.8 is unchanged.

**Real next steps, in priority order:**
1. A connector-aware fix in the footprint/obstacle-generation layer (not something this codebase controls — it's inside `@tscircuit/core`) that treats exactly-coincident same-net pads as a single obstacle, or a local clearance exception for them.
2. Alternatively, a footprint-level workaround: consciously omit the reversible connector's underside mirror pads from the *routed* footprint (keep them in the physical/fabrication footprint via `kicadPcbWriter.ts` post-processing instead of the CircuitRunner-routed path) — a bigger, more surgical change than this session had time for.
3. Re-attempt the board-size decision (§5.8's Option A) only after one of the above actually gets astracomputer-with-J2 to route successfully at *some* size — right now no size succeeds, so there is nothing to "pick between."

---

## 6. Next Steps

1. **Commit current state.** Stage the 4 bug fixes and all PCB layout files to establish a clean git history baseline.

2. ~~**Validate opamp_noninv through full DRC.**~~ **DONE (2026-08-10):** opamp_noninv validated through the real `serializeNirAsync` path — 3 silk_over_copper warnings (R3/R4/R5), 0 unconnected. Also completed: `mergeCollinearSegments` root-cause fix (phantom-diagonal/degenerate-trace corruption).

3. **Add DRC assertion to test suite.** Wrap `kicad-cli pcb drc` in a Bun test that asserts 0 violations and 0 unconnected items. Requires `kicad-cli` availability check (similar to ngspice skip pattern).

4. **Multi-layer routing validation.** Create a fixture that requires bottom-layer routing (e.g., crossing traces on a dense board) to exercise the via insertion path end-to-end.

5. **Expand fixture coverage.** Route all 6 v1.1 fixtures through the PCB pipeline. The `voltageDividerNir` and `rcLowpassAcNir` fixtures should be straightforward; `instrumentationAmpNir` (17 components) will test scalability.

6. **Gerber export.** Add `kicad-cli pcb export gerbers` invocation to produce fabrication-ready output files from the routed `.kicad_pcb`.

7. **Add trace-vs-trace (different net) clearance/short detection.** `enforceTracePadClearance` only checks trace-vs-*pad* clearance; there is no equivalent trace-vs-trace check, which is why `astracomputer`'s `shorting_items`/`tracks_crossing` violations (§5.5) are invisible to the current pipeline. Needs either a post-route clearance pass over trace pairs or improvements to the autorouter's own collision handling for dense boards.

8. **Investigate remaining `astracomputer` `holes_co_located` (7 remaining, was 10).** The via-dedup grid fix (§5.5) resolved the near-duplicate floating-point cases; the remaining 7 are exact-zero-distance duplicate vias on the same net from a source not yet identified — needs tracing back through `router.ts`/`mergeRoutedTraces` to find where two independent via insertions land on literally the same point.

9. ~~**Build a placement-density pass so real board-outline dimensions can be used safely.**~~ **INVESTIGATED (2026-08-25), confirmed infeasible without an external-dependency rewrite — see §5.8.** Placement itself (`calculate-packing`) already respects a target board size and packed astracomputer's 127 components into a 42×85mm target successfully (40.9×83.7mm bbox). The actual blocker is `@tscircuit/core`'s internal autorouter, which fails outright below ~4300-4800mm² regardless of aspect ratio (confirmed via an equal-area same-shape-as-working-default control test) — `calculate-packing`'s greedy bin-packer doesn't reserve routing-channel space, so a tightly-packed board has no room left to route through. Board size remains the 80×60mm default; `assertRoutingCompleted()` now fails loudly instead of silently shipping a truncated board if this is hit again. Real fix requires either an alternative placement algorithm (channel-aware) or accepting a larger board than the real one for auto-routed output.

10. ~~**Reconcile `astracomputer`'s real trace-vs-trace violations against the reference board's actual DRC.**~~ **DONE (2026-08-24) — see §5.7.** Real board: 283 violations/6 unconnected, **0 shorting_items**. Ours: 1154 violations/1 unconnected, 199 shorting_items. Confirms the shorting/clearance gap is real, not DRC-ruleset noise.

11. ~~**Fix the pre-existing J2/U7 `pinLabels` instantiation bug.**~~ **DONE (2026-08-24) — see §5.9.** `generateComponentJsx` now emits sequential fallback numeric `pin<N>` keys for non-numeric NIR `pin_number`s (J2's USB-C `A1`-`A12`/`B1`-`B12`/`S1`, U7's BGA-grid identifiers), keeping the real identifier as the `pinLabels` value. Verified: 0 `source_failed_to_create_component_error`, 0 `source_trace_not_connected_error`, `pcb_component` count 129 (127 + J2 + U7). Surfaced a pre-existing, out-of-scope side effect: the extra 47 pins' worth of nets push the already-fragile 80×60mm routing (§5.8) further into its capacity ceiling — DRC unconnected items rose from 1 to 317 in one run (only ~30 attributable to J2/U7 directly), and a repeat run failed to route at all. This is the §5.8 placement-density limitation becoming more visible, not a new defect.

12. ~~**Fix `assertRoutingCompleted`'s zero-`pcb_trace` blind spot.**~~ **DONE (2026-08-25) — see §5.10.** Removed the `if (traces.length === 0) return` early-out; both "no trace elements at all" and "trace elements with empty routes" are now correctly treated as the same routing-failure signature when the netlist required routing. Surfaced a second, previously-hidden pre-existing routing failure in the `layer2mockschema` test fixture — test updated to document it (`serializer.test.ts`).

13. **Get astracomputer-with-J2 to route at ANY board size (§5.10) — currently 0 for 7 sizes tested, 42mm² to 8000mm².** This supersedes item 9's "pick a board size" framing: no size succeeds while J2 is present, so there's no size to pick yet. Needs either an obstacle-generation fix for exactly-coincident same-net pads (upstream, in `@tscircuit/core`) or a footprint-level workaround that keeps J2's mirror pads in the fabrication footprint without asking the router to independently route to both. Until this lands, `serializeNirAsync(astraComputerNir)` throws at every tested size — there is currently no way to produce a full routed astracomputer board with J2 correctly wired.

14. **Add real net-name aliases where the NIR schema has them but they're not propagated (deferred, §5.9/net-name-shortening work).** `shortenAutoGeneratedNetName` (`serializer.ts`) strips KiCad's own auto-name wrapper for display, but doesn't attempt to recover a "more real" name from elsewhere in the schema — confirmed there isn't one for the ~35% of astracomputer's nets that use this fallback. If a future NIR extraction pass can recover better names (e.g. from schematic net labels), this is the place to wire them in.

---

## Appendix: Key Metrics

| Metric | Value |
|--------|-------|
| Total PCB module code | 1,974 lines (3 files) |
| Test count (PCB-specific) | 25 tests across 3 files |
| Autorouter dependency | `@tscircuit/capacity-autorouter@0.0.692` |
| KiCad target version | 10.0.4 (`version 20260206`, `generator_version "10.0"`) |
| DRC result (rc_lowpass) | 0 violations, 0 unconnected items |
| Supported footprints (library) | 10 types (0603, 0402, 1206, SOIC-8, MSOP-8, SOT-23-5, TSOT-23-5, 1x02 header) |
| Max fixture routed | opamp_noninv (11 components, 13 nets) |
