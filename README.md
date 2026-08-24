# Layer 3 — Serializer, PCB Pipeline & Simulator

Converts NIR (Neutral Intermediate Representation) circuit data into a
schematic SVG, a routed KiCad PCB, and/or a SPICE simulation — via Circuit
JSON as the shared intermediate format.

```
NIR (JSON)
   │
   ├─► serializeNir() / serializeNirAsync() ──► Circuit JSON ──► SVG schematic
   │                                                  │
   │                                                  ├─► KiCad .kicad_pcb (routed)
   │                                                  │
   └─► netlistFromCircuitJson() ──► SPICE netlist ──► ngspice ──► simulation vectors
```

---

## 0. Setup

```bash
bun install
```

System dependencies (install what you need for the parts you're touching):

| Dependency | Needed for | Install |
|---|---|---|
| **Bun** (v1.3.x) | everything — test runner + TS runtime | https://bun.sh |
| **Python 3** | Python bridge tests only | usually preinstalled |
| **ngspice** | simulation, interactive sim viewer, sim_server | `brew install ngspice` (macOS) / `apt install ngspice` (Linux) |
| **kicad-cli** (v10.0.4) | PCB DRC validation | install KiCad 10, `kicad-cli` ships with it |

No `pip install` step — the Python side (`serializer.py`, `simulator.py`,
`test_serializer.py`, `test_simulator.py`) only uses the standard library
plus `pytest`, which you'll already have if you run Python test suites.

---

## 1. Running the tests

```bash
# Everything (TypeScript)
bun test

# Just one area
bun test serializer.test.ts
bun test pcbRouting.test.ts router.test.ts kicadPcbWriter.test.ts
bun test simulator.test.ts

# Type check
bun run typecheck

# Python bridge
python3 -m pytest test_serializer.py -v
python3 -m pytest test_simulator.py -v
```

**Always verify with raw output**, not a summary — `bun test 2>&1 | tail -50`.
Test counts have silently shrunk across sessions before; don't trust a
reported pass count you haven't seen for yourself.

---

## 2. Schematic output (SVG)

**TypeScript:**
```ts
import { serializeNir } from "./serializer/serializer"
import { rcLowpassNir } from "./serializer/fixtures"

const result = serializeNir(rcLowpassNir)
// result.circuitJson, result.svg, result.viewerUsed
```

**Async (CircuitRunner auto-place/auto-route — used for anything with a
`board_spec`, i.e. anything that also needs PCB output):**
```ts
import { serializeNirAsync } from "./serializer/serializer"
import { opampNoninvNir } from "./serializer/fixtures"

const result = await serializeNirAsync(opampNoninvNir)
// result.circuitJson, result.svg, result.kicadPcb (if the NIR has a pcb_board)
```

**Python:**
```python
from serializer.serializer import serialize_nir
import json

with open("serializer/fixtures/instrumentation_amp_001.nir.json") as f:
    nir = json.load(f)

result = serialize_nir(nir)
# result.circuit_json, result.svg, result.viewer_used
```

**Live interactive schematic viewer** (persistent dev server, not a static
file — reads directly from `serializeNirAsync`):
```bash
bun run dev-tools/render_interactive_schematic.ts [fixture_name]
# writes dev-tools/current_schematic.html — open it in a browser
```

---

## 3. PCB output (routed KiCad board)

Any fixture with a `board_spec` in its NIR produces `result.kicadPcb` from
`serializeNirAsync` automatically — full pipeline (autoroute → Manhattan
snap → trace/pad clearance → chamfer → KiCad emit), no extra step needed.

**View it** (KiCanvas-based viewer, added in the `fix/pcblayoutviewer` PR):
```bash
bun run render:pcb [fixture_name]
# same as: bun run dev-tools/render_pcb_viewer.ts [fixture_name]
# writes dev-tools/current_pcb.html — open it in a browser

# available fixture_names:
#   rc_lowpass_001 (default) | opamp_noninv_001 | voltage_divider_001
#   rc_lowpass_ac_001 | rc_lowpass_fft_001 | instrumentation_amp_001
#   lm358_noninv_001 | 555_timer | audio_amplifier_1386 | audioamplifier_lm386
```

**Validate with DRC** (manual — not wired into the test suite):
```bash
# Generate a .kicad_pcb file to check. There are two ways to do this and
# they currently produce DIFFERENT output — see the note below.
kicad-cli pcb drc <file>.kicad_pcb -o /tmp/drc_out.json --format json
```

> ⚠️ **`_gen_pcb.ts` is a separate ad-hoc pipeline, not the production
> path.** `bun run _gen_pcb.ts rc_lowpass` (anything other than the literal
> string `rc_lowpass` routes the opamp fixture instead — no other fixture
> names are supported) re-routes from scratch and calls
> `removeZeroLengthSegments`, but skips `enforceTracePadClearance` and both
> chamfer passes entirely. Its DRC results are not representative of the
> real pipeline; always validate `serializeNirAsync`/`render_pcb_viewer.ts`
> output directly.
>
> The **clearance-blind-to-diagonals issue is fixed**: `chamferCircuitJsonTracesTo45Degree`
> now runs *before* `enforceTracePadClearance` in `serializeNirAsync`
> (previously it ran after, so the 45-degree segments it introduces were
> never checked against pad clearance), and `enforceTracePadClearance` itself
> now enforces clearance on diagonal segments too, not just Manhattan ones.
> `rc_lowpass` (0/0) and `opamp_noninv` (3 silk_over_copper, 0 unconnected)
> are unaffected. See `PCB_LAYOUT_REPORT.md` §5.4/§5.5 for the `astracomputer`
> DRC results, which surfaced a much larger set of pre-existing routing
> violations on dense/complex boards — still open, see the report for detail.

**Env flags** (real footprint/symbol data vs. hardcoded fallbacks):
```bash
OPEN_FORGE_USE_KICAD_SYMBOLS=1 OPEN_FORGE_USE_PARSED_FOOTPRINTS=1 bun test
```
Off (default): hardcoded `FOOTPRINT_SIZE_MM` values.
On: real pad-based dimensions parsed from `.kicad_mod` files in the KiCad
library — requires KiCad's footprint library to be installed at the
platform-standard path (e.g. `/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints/` on macOS).

---

## 4. Simulation (ngspice)

**Direct netlist:**
```ts
import { simulateNetlist } from "./simulator/simulator"

const result = await simulateNetlist(`
* RC filter
V1 in 0 PULSE(0 1 0 1n 1n 1m 2m)
R1 in out 1k
C1 out 0 1u
.tran 10u 5m
`)
console.log(result.vectors["v(out)"])
```

**From a NIR fixture, end to end:**
```ts
import { serializeNirAsync } from "./serializer/serializer"
import { netlistFromCircuitJson } from "./simulator/netlistFromCircuitJson"
import { simulateNetlist } from "./simulator/simulator"
import { rcLowpassNir } from "./serializer/fixtures"

const { circuitJson } = await serializeNirAsync(rcLowpassNir)
const { netlist } = netlistFromCircuitJson(circuitJson, rcLowpassNir)
const simResult = await simulateNetlist(netlist)
```

**Python:**
```python
from simulator.simulator import simulate_netlist

with open("simulator/fixtures/rc_circuit.cir") as f:
    result = simulate_netlist(f.read())
print(len(result.vectors["v(out)"]))
```

**Interactive simulator (sliders on component values), two ways:**
```bash
# One-shot static render for a single fixture:
bun run dev-tools/render_interactive_simulator.ts [fixture_name]
# writes dev-tools/current_sim.html

# Live server — re-simulates on every slider move, serves the page itself:
bun run dev-tools/sim_server.ts
# http://localhost:3777 (override with PORT=xxxx)
# GET  /fixture/:name   — component list for slider generation
# POST /simulate        — { fixture, components: { ref: value } } -> ngspice re-run
```

If you see `ngspice -v produced no output` or a hang: on Windows, point
`NGSPICE_BIN` at `ngspice_con.exe` (the console build), not `ngspice.exe`
(the GUI wrapper hangs in batch mode).

---

## 5. Files

| File | Purpose |
|---|---|
| `serializer/serializer.ts` | Core: schema parsing, layout, symbol rendering, SVG wire routing, PCB pipeline orchestration |
| `serializer/pcbRouting.ts` | PCB routing utilities — Circuit JSON ↔ SimpleRouteJson, placement clearance, trace-pad clearance, chamfering, collinear/zero-length cleanup |
| `serializer/router.ts` | Thin wrapper around `@tscircuit/capacity-autorouter`; Manhattan snap |
| `serializer/kicadPcbWriter.ts` | Circuit JSON → KiCad 10 `.kicad_pcb` S-expression writer |
| `serializer/serializer.py` | Python wrapper — calls `serializer.ts` via a Node/Bun subprocess bridge |
| `serializer/fixtures/index.ts` | Typed NIR fixture loader (v0.1 legacy + v1.1/v1.2 current) |
| `simulator/simulator.ts` | ngspice subprocess driver + `.raw` parser |
| `simulator/netlistFromCircuitJson.ts` | Circuit JSON + NIR → SPICE netlist |
| `simulator/parseRawFile.ts` | Pure `.raw` file parser (unit-testable) |
| `simulator/parseFourierOutput.ts` | AC/Fourier analysis output parser |
| `simulator/simulator.py` | Python wrapper — calls the TS simulator via a Bun bridge |
| `_gen_pcb.ts` | ⚠️ separate ad-hoc PCB regen/DRC script — see warning in §3, not the production path |
| `dev-tools/render_pcb_viewer.ts` | KiCanvas-based PCB viewer driver |
| `dev-tools/render_interactive_schematic.ts` | Interactive schematic viewer driver |
| `dev-tools/render_interactive_simulator.ts` | Static interactive simulator (uPlot) render |
| `dev-tools/sim_server.ts` | Live simulation server backing the slider UI |
| `dev-tools/axisScale.ts` | AC/time-domain axis scaling logic for the simulator viewer |
| `*.test.ts` | Bun test suites (`serializer.test.ts`, `pcbRouting.test.ts`, `router.test.ts`, `kicadPcbWriter.test.ts`, `simulator.test.ts`, plus dev-tools unit tests) |
| `test_serializer.py`, `test_simulator.py` | pytest suites for the Python bridges |

---

## 6. Schema versions supported

- **v0.1** (legacy, Libbrecht-Hall) — flat `source_component_base` /
  `source_net` / `source_trace` records. No positions, no confidence scores.
  Always synchronous (`serializeNir`), schematic-only, no PCB output.
- **v1.1 / v1.2** (current) — structured `components` / `netlist` /
  `board_spec`, per-component positions, per-layer confidence scores, named
  test points, natural-language placement rules. Use `serializeNirAsync` to
  get PCB output (`board_spec` triggers `kicadPcb` in the result).

Both are auto-detected from the input; you don't need to specify which one
you're passing in.

---

## 7. Known limitations

- **`placement_rules_text`** (natural-language placement rules) is parsed
  but not yet used to influence layout — planned for the verifier module,
  LLM-scoped to constraint translation only, not raw coordinate generation.
- **~~PCB routing is single-layer~~ — stale, corrected 2026-08-24.** This
  was true only for the small fixtures tested at the time it was written.
  `astracomputer` (4-layer `board_spec`) already routes across all 4
  copper layers with real vias — confirmed by inspecting the generated
  `.kicad_pcb` directly (F.Cu/In1.Cu/In2.Cu/B.Cu segment counts all
  nonzero). `layerCount` in `pcbRouting.ts:circuitJsonToSimpleRouteJson`
  reads `board.num_layers` dynamically; it isn't hardcoded to 1.
- **`serializer/router.ts` (`routeCircuit`/`routeCircuitJson`) is dead code
  for the real `serializeNirAsync` path.** Confirmed by grep: nothing in
  `serializer.ts` calls it — only `_gen_pcb.ts` (already flagged elsewhere
  as a separate ad-hoc pipeline) and the unit tests do. The actual
  production autorouting for `astracomputer` happens entirely *inside*
  `@tscircuit/core`'s own internal "capacity-mesh-autorouting" effect,
  invoked by `CircuitRunner` — which already uses the modern
  `AutoroutingPipelineSolver` internally regardless of what `router.ts`
  is set to. (An earlier session's notes describing a `router.ts` solver
  upgrade as improving `astracomputer`'s DRC numbers were mistaken — that
  file simply isn't in the code path that fixture exercises. `router.ts`
  itself still uses the correct, non-deprecated solver, which is fine, but
  it has no bearing on `astracomputer`'s output.)
- **`enforceTracePadClearance` only checks trace-vs-*pad* clearance,
  never trace-vs-trace.** This is the actual remaining driver of most of
  `astracomputer`'s DRC violation count (see `PCB_LAYOUT_REPORT.md` §5.5),
  since `@tscircuit/core`'s internal autorouter leaves same-layer,
  different-net crossings on a board this dense that nothing downstream
  checks for.
- **DRC is manual**, not part of the test suite or CI — see §3's `_gen_pcb.ts`
  warning; the documented "0 violations" result needs to be reconciled
  against the actual `serializeNirAsync` pipeline.
- **`astracomputer` currently cannot be fully autorouted at ANY board size
  once J2 (USB-C) is correctly wired — confirmed across 7 sizes from
  4290mm² to 8000mm² (2026-08-25, `PCB_LAYOUT_REPORT.md` §5.10).** J2's
  real footprint places reversible-connector mirror pins (A1/B12, etc.) at
  literally identical physical coordinates — a genuine, deliberate
  characteristic confirmed against the real reference board, not a
  fixture bug. `@tscircuit/core`'s internal autorouter cannot route
  around the resulting fully-coincident pad obstacles and fails for the
  *entire* board, not just locally near J2 — confirmed by removing only
  J2, which restores 100% successful routing at the original 80×60mm
  size. Board size is not the lever here: every tested size, including
  ones far larger than the original 80×60mm default, failed identically.
  `serializeNirAsync(astraComputerNir)` now throws
  (`assertRoutingCompleted` in `serializer.ts`) rather than silently
  shipping a traceless `.kicad_pcb`, so there is currently no way to
  produce a fully routed astracomputer board with J2 correctly included.
  A real fix needs either an obstacle-generation change upstream in
  `@tscircuit/core` (not something this codebase controls) or a
  footprint-level workaround that keeps J2's mirror pads in the
  fabrication footprint without asking the autorouter to route to both.
  (Separately: the real board's exact 42×85mm outline was also confirmed
  infeasible to wire in directly for unrelated placement-density reasons
  — see `PCB_LAYOUT_REPORT.md` §5.8 for that investigation.)
- **Mounting holes and board-level silkscreen graphics (logos, connector
  labels) from a real reference board are not emitted.** `astracomputer`'s
  NIR fixture carries real mounting-hole positions
  (`_NEW_mechanical_constraints.mounting_holes`, 4x M2.5 at the real
  board's corners) but they're expressed in the *real* board's coordinate
  frame, which only lines up with our output once the board-outline issue
  above is fixed — still blocked, see above. Free-floating silkscreen
  graphics ("ASTRA" logo, "2S VIN", net labels) on the real board are
  purely manual KiCad artwork with no NIR schema field at all — genuinely
  absent from source data, not something to fabricate.
- **Only passive components (R, C, L, D) and independent sources (V, I)**
  are modeled as real SPICE primitives in the simulator. ICs are emitted as
  1-ohm placeholder resistors with a warning — no `.subckt` models bundled.
- **No Monte Carlo / parameter sweeps** in `simulator.ts` — single-run only.
  (Monte Carlo requires manual `agauss()`/`unif()` in `.control` blocks or an
  external batch wrapper; ngspice has no built-in support.)