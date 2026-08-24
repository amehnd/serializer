import { describe, it, expect, beforeAll } from "bun:test"
import { circuitJsonToKicadPcb, computePcbPageGeometry } from "./serializer/kicadPcbWriter"
import { serializeNirAsync } from "./serializer/serializer"
import { opampNoninvNir, rcLowpassNir, instrumentationAmpNir } from "./serializer/fixtures"
import type { AnyCircuitElement } from "circuit-json"

describe("circuitJsonToKicadPcb", () => {
  let circuitJson: AnyCircuitElement[]
  let kicadPcb: string

  beforeAll(async () => {
    const out = await serializeNirAsync(opampNoninvNir)
    circuitJson = out.circuitJson
    kicadPcb = circuitJsonToKicadPcb(circuitJson)
  })

  it("produces a non-empty string starting with (kicad_pcb", () => {
    expect(typeof kicadPcb).toBe("string")
    expect(kicadPcb.length).toBeGreaterThan(100)
    expect(kicadPcb.startsWith("(kicad_pcb")).toBe(true)
  })

  it("has a (generator ...) field with the project name from package.json", () => {
    expect(kicadPcb).toContain("(generator ")
    expect(kicadPcb).toContain("my-project")
  })

  it("has (version ...) field", () => {
    expect(kicadPcb).toContain("(version ")
  })

  it("has a (general ...) section", () => {
    expect(kicadPcb).toContain("(general")
    expect(kicadPcb).toContain("(thickness")
  })

  it("has a (layers ...) section with top and bottom copper", () => {
    expect(kicadPcb).toContain("(layers")
    expect(kicadPcb).toContain("F.Cu")
    expect(kicadPcb).toContain("B.Cu")
  })

  it("has a (setup ...) section", () => {
    expect(kicadPcb).toContain("(setup")
    expect(kicadPcb).toContain("(pad_to_mask_clearance")
  })

  it("has (net ...) declarations for each source_net", () => {
    const sourceNets = circuitJson.filter((e: any) => e.type === "source_net") as any[]
    expect(sourceNets.length).toBeGreaterThan(0)

    for (const net of sourceNets) {
      const netName = net.name ?? net.source_net_id
      expect(kicadPcb).toContain(`"${netName}"`)
    }
  })

  it("emits one (footprint ...) block per pcb_component", () => {
    const pcbComponents = circuitJson.filter((e: any) => e.type === "pcb_component") as any[]
    expect(pcbComponents.length).toBeGreaterThan(0)

    const footprintMatches = kicadPcb.match(/\(footprint "/g) || []
    expect(footprintMatches.length).toBeGreaterThanOrEqual(pcbComponents.length)

    for (const comp of pcbComponents) {
      const sc = circuitJson.find(
        (e: any) => e.type === "source_component" && e.source_component_id === comp.source_component_id
      ) as any
      const refDes = sc?.name ?? ""
      if (refDes) {
        expect(kicadPcb).toContain(`(property "Reference" "${refDes}"`)
      }
    }
  })

  it("footprint blocks have (at X Y R) from pcb_component center and rotation, offset to the page center", () => {
    const board = circuitJson.find((e: any) => e.type === "pcb_board") as any
    const { pageOffset } = computePcbPageGeometry(board.width ?? 80, board.height ?? 60)
    const pcbComponents = circuitJson.filter((e: any) => e.type === "pcb_component") as any[]
    for (const comp of pcbComponents.slice(0, 3)) {
      const x = (comp.center.x + pageOffset.x).toFixed(4)
      const y = (comp.center.y + pageOffset.y).toFixed(4)
      expect(kicadPcb).toContain(`(at ${x} ${y}`)
    }
  })

  it("footprint blocks reference F.Cu or B.Cu layer", () => {
    expect(kicadPcb).toContain('(layer "F.Cu")')
  })

  it("emits (segment ...) entries for wire pcb_trace routes", () => {
    const pcbTraces = circuitJson.filter((e: any) => e.type === "pcb_trace") as any[]
    const hasWires = pcbTraces.some((t) => t.route?.some((s: any) => s.route_type === "wire"))
    if (hasWires) {
      expect(kicadPcb).toContain("(segment")
      expect(kicadPcb).toContain("(start ")
      expect(kicadPcb).toContain("(end ")
    }
  })

  it("emits (via ...) entries for via pcb_trace routes", () => {
    const pcbTraces = circuitJson.filter((e: any) => e.type === "pcb_trace") as any[]
    const hasVias = pcbTraces.some((t) => t.route?.some((s: any) => s.route_type === "via"))
    if (hasVias) {
      expect(kicadPcb).toContain("(via")
      expect(kicadPcb).toContain("(at ")
      expect(kicadPcb).toContain("(layers ")
    }
  })

  it("segments and vias reference valid net names", () => {
    const viaMatches = kicadPcb.matchAll(/\(via[\s\S]*?\(net \d+ "([^"]+)"\)/g) || []
    for (const m of viaMatches) {
      const netName = m[1]
      expect(netName.length).toBeGreaterThan(0)
    }
  })

  it("uses footprint paths from FOOTPRINT_MAP for recognized footprints", () => {
    expect(kicadPcb).toContain("Package_SO/SOIC-8_3.9x4.9mm_P1.27mm")
    expect(kicadPcb).toContain("Resistor_SMD/R_0603_1608Metric")
  })

  it("closes with a single matching closing paren", () => {
    expect(kicadPcb.trimEnd().endsWith(")")).toBe(true)
    const openCount = (kicadPcb.match(/\(/g) || []).length
    const closeCount = (kicadPcb.match(/\)/g) || []).length
    expect(openCount).toBe(closeCount)
  })
})

describe("pad rotation regression: net-to-net short detection", () => {
  function parsePads(kicadPcb: string) {
    const lines = kicadPcb.split("\n")
    const pads: Array<{ num: string; x: number; y: number; w: number; h: number; net: string }> = []
    let curFpX = 0, curFpY = 0, curFpRot = 0
    let inFp = false
    let curPad: { num: string; relX: number; relY: number; w: number; h: number; net: string } | null = null

    for (const line of lines) {
      if (line.match(/^\s{2}\(footprint /)) {
        if (curPad) {
          const cosR = Math.cos(curFpRot), sinR = Math.sin(curFpRot)
          pads.push({
            num: curPad.num,
            x: curFpX + cosR * curPad.relX - sinR * curPad.relY,
            y: curFpY + sinR * curPad.relX + cosR * curPad.relY,
            w: curPad.w, h: curPad.h, net: curPad.net,
          })
          curPad = null
        }
        inFp = true
        curFpX = 0; curFpY = 0; curFpRot = 0
      }
      if (inFp) {
        const fpAt = line.match(/^\s{4}\(at ([\d.\-]+) ([\d.\-]+)(?: ([\d.\-]+))?\)/)
        if (fpAt) {
          curFpX = parseFloat(fpAt[1])
          curFpY = parseFloat(fpAt[2])
          curFpRot = fpAt[3] ? parseFloat(fpAt[3]) * Math.PI / 180 : 0
        }
      }

      const padStart = line.match(/\(pad "?(\d+)"? (?:smd|thru_hole) (?:roundrect|rect|circle)/)
      if (padStart) {
        if (curPad) {
          const cosR = Math.cos(curFpRot), sinR = Math.sin(curFpRot)
          pads.push({
            num: curPad.num,
            x: curFpX + cosR * curPad.relX - sinR * curPad.relY,
            y: curFpY + sinR * curPad.relX + cosR * curPad.relY,
            w: curPad.w, h: curPad.h, net: curPad.net,
          })
        }
        curPad = { num: padStart[1], relX: 0, relY: 0, w: 1, h: 1, net: "" }
      }

      if (curPad) {
        const atM = line.match(/\(at ([\d.\-]+) ([\d.\-]+)\)/)
        if (atM) { curPad.relX = parseFloat(atM[1]); curPad.relY = parseFloat(atM[2]) }
        const sizeM = line.match(/\(size ([\d.\-]+) ([\d.\-]+)\)/)
        if (sizeM) { curPad.w = parseFloat(sizeM[1]); curPad.h = parseFloat(sizeM[2]) }
        const netM = line.match(/\(net (\d+) "([^"]*)"\)/)
        if (netM) curPad.net = netM[2]
      }
    }

    if (curPad) {
      const cosR = Math.cos(curFpRot), sinR = Math.sin(curFpRot)
      pads.push({
        num: curPad.num,
        x: curFpX + cosR * curPad.relX - sinR * curPad.relY,
        y: curFpY + sinR * curPad.relX + cosR * curPad.relY,
        w: curPad.w, h: curPad.h, net: curPad.net,
      })
    }

    return pads
  }

  it("parses pad positions from KiCad output and checks no different-net pads overlap", async () => {
    const out = await serializeNirAsync(rcLowpassNir)
    const kicadPcbRc = circuitJsonToKicadPcb(out.circuitJson, rcLowpassNir as any)
    const pads = parsePads(kicadPcbRc)

    expect(pads.length).toBeGreaterThan(0)

    const MIN_CLEARANCE = 0.01
    for (let i = 0; i < pads.length; i++) {
      for (let j = i + 1; j < pads.length; j++) {
        const a = pads[i]
        const b = pads[j]
        if (a.net === b.net || a.net === "" || b.net === "") continue

        const overlapX = (a.w / 2 + b.w / 2 + MIN_CLEARANCE) - Math.abs(a.x - b.x)
        const overlapY = (a.h / 2 + b.h / 2 + MIN_CLEARANCE) - Math.abs(a.y - b.y)

        if (overlapX > 0 && overlapY > 0) {
          expect(
            false,
            `Net-to-net short: pad ${a.num} [${a.net}] at (${a.x.toFixed(4)}, ${a.y.toFixed(4)}) overlaps pad ${b.num} [${b.net}] at (${b.x.toFixed(4)}, ${b.y.toFixed(4)}). ` +
            `This means the rotation transform is wrong — pads are at incorrect absolute positions.`,
          ).toBe(true)
        }
      }
    }
  })

  it("rotated components have pads at correct absolute positions (rotation transform check)", async () => {
    const out = await serializeNirAsync(rcLowpassNir)
    // circuitJsonToKicadPcb applies centering in-place; use the same
    // (now-centered) array for both KiCad and smtpad extraction.
    const kicadPcbRc = circuitJsonToKicadPcb(out.circuitJson, rcLowpassNir as any)
    const board = out.circuitJson.find((e: any) => e.type === "pcb_board") as any
    const { pageOffset } = computePcbPageGeometry(board.width ?? 80, board.height ?? 60)
    const components = out.circuitJson.filter((e: any) => e.type === "pcb_component") as any[]
    const smtpads = out.circuitJson.filter((e: any) => e.type === "pcb_smtpad") as any[]
    const compMap = new Map(components.map((c: any) => [c.pcb_component_id, c]))

    const kicadPads = parsePads(kicadPcbRc)

    for (const pad of smtpads) {
      const comp = compMap.get(pad.pcb_component_id)
      if (!comp) continue

      const matched = kicadPads.find((kp) =>
        Math.abs(kp.x - (pad.x + pageOffset.x)) < 0.1 &&
        Math.abs(kp.y - (pad.y + pageOffset.y)) < 0.1,
      )

      expect(matched).toBeDefined()
    }
  })
})

describe("PCB page centering (rendering/layout fix)", () => {
  it("board outline (gr_rect) is centered on the page for a fixture with a non-trivial board_spec", async () => {
    const out = await serializeNirAsync(instrumentationAmpNir)
    const kicadPcb = circuitJsonToKicadPcb(out.circuitJson)
    const board = out.circuitJson.find((e: any) => e.type === "pcb_board") as any
    const { paperWidth, paperHeight } = computePcbPageGeometry(board.width ?? 80, board.height ?? 60)

    expect(kicadPcb).toContain(`(paper "User" ${paperWidth.toFixed(4)} ${paperHeight.toFixed(4)})`)

    const match = kicadPcb.match(
      /\(gr_rect \(start ([\d.\-]+) ([\d.\-]+)\) \(end ([\d.\-]+) ([\d.\-]+)\)/,
    )
    expect(match).not.toBeNull()
    const [, startX, startY, endX, endY] = match!.map(Number) as unknown as [number, number, number, number, number]

    const centerX = (startX + endX) / 2
    const centerY = (startY + endY) / 2

    const TOLERANCE_MM = 0.01
    expect(Math.abs(centerX - paperWidth / 2)).toBeLessThan(TOLERANCE_MM)
    expect(Math.abs(centerY - paperHeight / 2)).toBeLessThan(TOLERANCE_MM)
  })
})
