import type { AnyCircuitElement } from "circuit-json"
import { FOOTPRINT_MAP } from "./serializer"
import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

function getGeneratorName(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"))
    return pkg.name ?? "my-project"
  } catch {
    return "my-project"
  }
}

function layerToKicad(layer: string): string {
  switch (layer) {
    case "top": return "F.Cu"
    case "bottom": return "B.Cu"
    case "inner1": return "In1.Cu"
    case "inner2": return "In2.Cu"
    case "inner3": return "In3.Cu"
    case "inner4": return "In4.Cu"
    default: return layer.startsWith("F.") || layer.startsWith("B.") || layer.startsWith("In") ? layer : "F.Cu"
  }
}

function buildLayersSection(layerCount: number): string {
  // KiCad 10 (version 20260206) uses standard KiCad layer numbering
  const layers: string[] = [
    '(0 "F.Cu" signal)',
    `(2 ${layerCount > 1 ? '"B.Cu" signal)' : '"In1.Cu" signal)'}`,
  ]
  for (let i = 2; i < layerCount; i++) {
    layers.push(`(${i} "In${i - 1}.Cu" signal)`)
  }
  layers.push(
    '(1 "F.Mask" user)',
    '(3 "B.Mask" user)',
    '(5 "F.SilkS" user "F.Silkscreen")',
    '(7 "B.SilkS" user "B.Silkscreen")',
    '(13 "F.Paste" user)',
    '(15 "B.Paste" user)',
    '(19 "Cmts.User" user "User.Comments")',
    '(25 "Edge.Cuts" user)',
    '(27 "Margin" user)',
    '(29 "B.CrtYd" user "B.Courtyard")',
    '(31 "F.CrtYd" user "F.Courtyard")',
    '(33 "B.Fab" user "B.Fabrication")',
    '(35 "F.Fab" user "F.Fabrication")',
  )
  return `  (layers\n    ${layers.join("\n    ")}\n  )`
}

function buildSetupSection(): string {
  return `  (setup
    (pad_to_mask_clearance 0.05)
    (allow_soldermask_bridges_in_footprints no)
    (tenting
      (front yes)
      (back yes)
    )
    (covering
      (front no)
      (back no)
    )
    (plugging
      (front no)
      (back no)
    )
    (capping no)
    (filling no)
    (pcbplotparams
      (layerselection 0x00000000_00000000_55555555_5755f5ff)
      (plot_on_all_layers_selection 0x00000000_00000000_00000000_00000000)
      (disableapertmacros no)
      (usegerberextensions no)
      (usegerberattributes yes)
      (usegerberadvancedattributes yes)
      (creategerberjobfile yes)
      (gerberprecision 5)
      (dashed_line_dash_ratio 12)
      (dashed_line_gap_ratio 3)
      (svgprecision 4)
      (plotframeref no)
      (mode 1)
      (useauxorigin no)
      (pdf_front_fp_property_popups yes)
      (pdf_back_fp_property_popups yes)
      (pdf_metadata yes)
      (pdf_single_document no)
      (dxfpolygonmode yes)
      (dxfimperialunits yes)
      (dxfusepcbnewfont yes)
      (psnegative no)
      (psa4output no)
      (plot_black_and_white yes)
      (sketchpadsonfab no)
      (plotpadnumbers no)
      (hidednponfab no)
      (sketchdnponfab yes)
      (crossoutdnponfab yes)
      (subtractmaskfromsilk no)
      (outputformat 1)
      (mirror no)
      (drillshape 1)
      (scaleselection 1)
      (outputdirectory "")
    )
  )`
}

function buildNetSection(sourceNets: any[]): string {
  const lines: string[] = []
  lines.push(`  (net 0 "")`)
  for (let i = 0; i < sourceNets.length; i++) {
    const net = sourceNets[i]
    const netName = net.name ?? net.source_net_id
    lines.push(`  (net ${i + 1} "${netName}")`)
  }
  return lines.join("\n")
}

function extractFootprintPath(cadComponent: any): string | null {
  if (!cadComponent?.model_step_url) return null
  const url = cadComponent.model_step_url as string
  const match = url.match(/\/([^/]+\/[^/]+)\.step$/)
  if (match) return match[1]
  const match2 = url.match(/\/([^/]+)\.step$/)
  if (match2) return match2[1]
  return null
}

function buildFootprintBlocks(
  circuitJson: AnyCircuitElement[],
  sourceNets: any[],
  pageOffset: { x: number; y: number },
): string {
  const pcbComponents = circuitJson.filter((e: any) => e.type === "pcb_component") as any[]
  const sourceComponents = circuitJson.filter((e: any) => e.type === "source_component") as any[]
  const cadComponents = circuitJson.filter((e: any) => e.type === "cad_component") as any[]
  const silkscreenTexts = circuitJson.filter((e: any) => e.type === "pcb_silkscreen_text") as any[]
  const smtpads = circuitJson.filter((e: any) => e.type === "pcb_smtpad") as any[]
  const platedHoles = circuitJson.filter((e: any) => e.type === "pcb_plated_hole") as any[]
  const pcbPorts = circuitJson.filter((e: any) => e.type === "pcb_port") as any[]
  const sourceTraces = circuitJson.filter((e: any) => e.type === "source_trace") as any[]

  // Build net assignment lookup structures
  const portByPcbPortId = new Map(pcbPorts.map((p: any) => [p.pcb_port_id, p]))
  const traceBySourcePortId = new Map<string, any>()
  for (const st of sourceTraces) {
    for (const spId of (st.connected_source_port_ids ?? [])) {
      traceBySourcePortId.set(spId, st)
    }
  }
  const netIdToName = new Map<string, string>()
  for (const n of sourceNets) {
    netIdToName.set(n.source_net_id, n.name ?? n.source_net_id)
  }
  // Net name -> declaration index, matching buildNetSection's numbering
  // (sourceNets[i] -> i + 1, empty string -> 0). Pads use indexed
  // (net N "name") references; tracks/vias must use the index-only
  // (net N) form or KiCad fails to load the board.
  const netNameToIndex = new Map<string, number>()
  netNameToIndex.set("", 0)
  for (let i = 0; i < sourceNets.length; i++) {
    const net = sourceNets[i]
    netNameToIndex.set(net.name ?? net.source_net_id, i + 1)
    netNameToIndex.set(net.source_net_id, i + 1)
  }
  // source_port -> net name
  const sourcePortNetMap = new Map<string, string>()
  for (const st of sourceTraces) {
    for (const spId of (st.connected_source_port_ids ?? [])) {
      const netId = st.connected_source_net_ids?.[0]
      if (netId) sourcePortNetMap.set(spId, netIdToName.get(netId) ?? "")
    }
  }
  // source_port grouped by source_component_id
  const sourcePortsByComp = new Map<string, any[]>()
  {
    const srcPorts = circuitJson.filter((e: any) => e.type === "source_port") as any[]
    for (const sp of srcPorts) {
      if (!sp.source_component_id) continue
      if (!sourcePortsByComp.has(sp.source_component_id)) sourcePortsByComp.set(sp.source_component_id, [])
      sourcePortsByComp.get(sp.source_component_id)!.push(sp)
    }
  }
  // source_component_id by pcb_component_id
  const srcCompIdByPcbCompId = new Map(pcbComponents.map((c: any) => [c.pcb_component_id, c.source_component_id]))

  // smtpad -> net name (via pcb_port chain — reliable when port IDs are correct)
  const padNetMap = new Map<string, string>()
  for (const pad of smtpads) {
    if (!pad.pcb_port_id) continue
    const port = portByPcbPortId.get(pad.pcb_port_id)
    if (!port?.source_port_id) continue
    const trace = traceBySourcePortId.get(port.source_port_id)
    if (!trace?.connected_source_net_ids?.length) continue
    const netName = netIdToName.get(trace.connected_source_net_ids[0])
    if (netName) padNetMap.set(pad.pcb_smtpad_id, netName)
  }

  // plated hole -> net name
  // Use pcb_port chain as primary, fall back to component-level assignment
  // (CircuitRunner may assign wrong pcb_port IDs to plated holes)
  const phNetMap = new Map<string, string>()
  for (const ph of platedHoles) {
    const srcCompId = srcCompIdByPcbCompId.get(ph.pcb_component_id)
    // Try pcb_port chain first
    if (ph.pcb_port_id) {
      const port = portByPcbPortId.get(ph.pcb_port_id)
      if (port?.source_port_id) {
        // Verify this source_port belongs to the same component
        const srcPorts = sourcePortsByComp.get(srcCompId ?? "") ?? []
        const srcPortIds = new Set(srcPorts.map((s: any) => s.source_port_id))
        if (srcPortIds.has(port.source_port_id)) {
          const trace = traceBySourcePortId.get(port.source_port_id)
          if (trace?.connected_source_net_ids?.length) {
            const netName = netIdToName.get(trace.connected_source_net_ids[0])
            if (netName) { phNetMap.set(ph.pcb_plated_hole_id, netName); continue }
          }
        }
      }
    }
    // Fallback: match by position or port_hints within the component
    if (srcCompId) {
      const srcPorts = sourcePortsByComp.get(srcCompId) ?? []
      // Sort by y (top-to-bottom for vertical connectors)
      const sortedSrcPorts = [...srcPorts].sort((a: any, b: any) => {
        const pa = portByPcbPortId.get(a.pcb_port_id)
        const pb = portByPcbPortId.get(b.pcb_port_id)
        return (pb?.y ?? 0) - (pa?.y ?? 0) // descending y = top to bottom
      })
      const hint = (ph.port_hints ?? []).find((h: string) => /^\d+$/.test(h))
      let matchIdx = hint ? parseInt(hint) - 1 : -1
      if (matchIdx >= 0 && matchIdx < sortedSrcPorts.length) {
        const sp = sortedSrcPorts[matchIdx]
        const netName = sourcePortNetMap.get(sp.source_port_id)
        if (netName) phNetMap.set(ph.pcb_plated_hole_id, netName)
      }
    }
  }

  const sourceCompMap = new Map(sourceComponents.map((c) => [c.source_component_id, c]))
  const cadCompByPcbId = new Map(cadComponents.map((c) => [c.pcb_component_id, c]))
  const silkByPcbId = new Map(silkscreenTexts.map((s) => [s.pcb_component_id, s]))
  const padsByPcbId = smtpads.reduce((map, pad) => {
    if (!pad.pcb_component_id) return map
    if (!map.has(pad.pcb_component_id)) map.set(pad.pcb_component_id, [])
    map.get(pad.pcb_component_id).push(pad)
    return map
  }, new Map<string, any[]>())
  // Also add plated holes to padsByPcbId for collision detection
  for (const ph of platedHoles) {
    if (!ph.pcb_component_id) continue
    if (!padsByPcbId.has(ph.pcb_component_id)) padsByPcbId.set(ph.pcb_component_id, [])
    padsByPcbId.get(ph.pcb_component_id).push(ph)
  }
  const phsByPcbId = platedHoles.reduce((map, ph) => {
    if (!ph.pcb_component_id) return map
    if (!map.has(ph.pcb_component_id)) map.set(ph.pcb_component_id, [])
    map.get(ph.pcb_component_id).push(ph)
    return map
  }, new Map<string, any[]>())

  const blocks: string[] = []

  // Reference-text bounding boxes already placed, in world coordinates.
  // checkCollision below tests candidate ref positions against neighboring
  // component bodies/pads AND against these — without it, two tightly
  // packed passives can each independently pick a ref position that avoids
  // bodies/pads but overlaps the OTHER's reference text (silk_overlap in
  // KiCad DRC).
  const placedRefBoxes: Array<{ wx: number; wy: number; halfW: number; halfH: number }> = []

  for (const comp of pcbComponents) {
    const sc = sourceCompMap.get(comp.source_component_id)
    const refDes = sc?.name ?? comp.pcb_component_id
    const cad = cadCompByPcbId.get(comp.pcb_component_id)
    const silk = silkByPcbId.get(comp.pcb_component_id)
    const pads = padsByPcbId.get(comp.pcb_component_id) ?? []
    const phs = phsByPcbId.get(comp.pcb_component_id) ?? []
    const hasThruHole = phs.length > 0

    let footprintPath = extractFootprintPath(cad) ?? "Resistor_SMD/R_0603_1608Metric"
    let footprintValue = footprintPath
    for (const [name, mapped] of Object.entries(FOOTPRINT_MAP)) {
      if (mapped.includes(footprintPath) || mapped.endsWith(footprintPath)) {
        footprintValue = mapped.replace("kicad:", "")
        break
      }
    }
    const footprintUuid = comp.pcb_component_id.replace(/[^0-9a-fA-F]/g, "").padEnd(16, "0").slice(0, 16)
    const kicadLayer = layerToKicad(comp.layer ?? "top")
    const rotDeg = comp.rotation ?? 0

    const padLines: string[] = []
    const rotRad = (comp.rotation ?? 0) * Math.PI / 180
    const cosR = Math.cos(rotRad)
    const sinR = Math.sin(rotRad)

    // Generate SMD pad entries
    const smtPadsForComp = smtpads.filter((p: any) => p.pcb_component_id === comp.pcb_component_id)
    for (let pi = 0; pi < smtPadsForComp.length; pi++) {
      const pad = smtPadsForComp[pi]
      const padLayer = layerToKicad(pad.layer ?? "top")
      const dx = pad.x - comp.center.x
      const dy = pad.y - comp.center.y
      // KiCad uses CW rotation: local = CW⁻¹(world_offset)
      // CW⁻¹(x,y) = (x*cosθ - y*sinθ, x*sinθ + y*cosθ)
      const padX = cosR * dx - sinR * dy
      const padY = sinR * dx + cosR * dy
      const padW = pad.width ?? 0.6
      const padH = pad.height ?? 0.6
      const padNum = (pad.port_hints?.find((h: string) => /^\d+$/.test(h)) ?? String(pi + 1)) as string
      const maskLayer = padLayer.replace('.Cu', '.Mask')
      const netName = padNetMap.get(pad.pcb_smtpad_id)
      const netIdx = netName ? netNameToIndex.get(netName) ?? 0 : 0
      const netProp = ` (net ${netIdx} "${netName ?? ""}")`
      padLines.push(
        `        (pad "${padNum}" smd roundrect (at ${padX.toFixed(4)} ${padY.toFixed(4)}) (size ${padW.toFixed(4)} ${padH.toFixed(4)}) (layers "${padLayer}" "${maskLayer}") (roundrect_rratio 0.25)${netProp})`
      )
    }

    // Generate through-hole pad entries for plated holes
    for (let pi = 0; pi < phs.length; pi++) {
      const ph = phs[pi]
      const dx = ph.x - comp.center.x
      const dy = ph.y - comp.center.y
      const padX = cosR * dx - sinR * dy
      const padY = sinR * dx + cosR * dy
      const padNum = (ph.port_hints?.find((h: string) => /^\d+$/.test(h)) ?? String(smtPadsForComp.length + pi + 1)) as string
      const drillDiam = ph.hole_diameter ?? 1.0
      let padW: number, padH: number, kicadShape: string
      if (ph.shape === "circular_hole_with_rect_pad") {
        padW = ph.rect_pad_width ?? 1.7
        padH = ph.rect_pad_height ?? 1.7
        kicadShape = "oval"
      } else {
        const d = ph.outer_diameter ?? 1.7
        padW = d
        padH = d
        kicadShape = "circle"
      }
      const netName = phNetMap.get(ph.pcb_plated_hole_id)
      const netIdx = netName ? netNameToIndex.get(netName) ?? 0 : 0
      const netProp = ` (net ${netIdx} "${netName ?? ""}")`
      padLines.push(
        `        (pad "${padNum}" thru_hole ${kicadShape} (at ${padX.toFixed(4)} ${padY.toFixed(4)}) (size ${padW.toFixed(4)} ${padH.toFixed(4)}) (drill ${drillDiam.toFixed(4)}) (layers "*.Cu")${netProp})`
      )
    }

    const silkRef = silk ?? { text: refDes, font_size: 0.6, anchor_position: { x: comp.center.x, y: comp.center.y + 1 }, ccw_rotation: 0 }
    const refUuid = `ref_${footprintUuid}`
    const valUuid = `val_${footprintUuid}`

    const silkLayer = kicadLayer === "F.Cu" ? "F.SilkS" : kicadLayer === "B.Cu" ? "B.SilkS" : `${kicadLayer}.SilkS`

    // Compute ref text position: at center for ICs, outside body for passives
    // Pad positions are in world coords; text position is in local (pre-rotation) frame
    const halfW = comp.width / 2
    const halfH = comp.height / 2
    const compPads = pads.filter((p: any) => p.pcb_component_id === comp.pcb_component_id)
    // Inverse-rotate world pad positions to local frame
    const localPads = compPads.map((p: any) => {
      const wx = p.x - comp.center.x
      const wy = p.y - comp.center.y
      return { lx: wx * cosR + wy * sinR, ly: -wx * sinR + wy * cosR }
    })
    const localSpreadX = Math.max(...localPads.map((p: any) => Math.abs(p.lx)), 0)
    const localSpreadY = Math.max(...localPads.map((p: any) => Math.abs(p.ly)), 0)
    const localPadAxis = localSpreadX > localSpreadY ? "X" : "Y"
    const isIC = compPads.length > 4

    const REF_FONT = 0.8
    const REF_OFFSET = 0.5
    let refX = 0
    let refY = 0
    if (!isIC) {
      if (localPadAxis === "X") {
        refY = halfH + REF_OFFSET
      } else {
        refX = halfW + REF_OFFSET
      }
      // Check if ref text would collide with any neighbor component or its pads
      // KiCad applies CW rotation to local coords to get world position
      const cosComp = Math.cos((rotDeg * Math.PI) / 180)
      const sinComp = Math.sin((rotDeg * Math.PI) / 180)
      function localToWorld(lx: number, ly: number) {
        return {
          wx: comp.center.x + lx * cosComp + ly * sinComp,
          wy: comp.center.y - lx * sinComp + ly * cosComp,
        }
      }
      const refHalfW = 1.0
      const refHalfH = REF_FONT / 2
      function checkCollision(lx: number, ly: number) {
        const { wx, wy } = localToWorld(lx, ly)
        const bodyOrPadHit = pcbComponents.some((other: any) => {
          if (other.pcb_component_id === comp.pcb_component_id) return false
          const dx = Math.abs(wx - other.center.x)
          const dy = Math.abs(wy - other.center.y)
          const overlapX = dx < refHalfW + other.width / 2 + 0.2
          const overlapY = dy < refHalfH + other.height / 2 + 0.2
          if (overlapX && overlapY) return true
          const otherPads = padsByPcbId.get(other.pcb_component_id) ?? []
          for (const op of otherPads) {
            const pdx = Math.abs(wx - op.x)
            const pdy = Math.abs(wy - op.y)
            if (pdx < refHalfW + (op.width ?? 0) / 2 + 0.1 && pdy < refHalfH + (op.height ?? 0) / 2 + 0.1) return true
          }
          return false
        })
        if (bodyOrPadHit) return true
        // Also avoid landing on a reference text already placed for another
        // component (silk_overlap in DRC) — body/pad checks alone miss this
        // in tightly packed clusters.
        return placedRefBoxes.some((rb) => {
          const dx = Math.abs(wx - rb.wx)
          const dy = Math.abs(wy - rb.wy)
          return dx < refHalfW + rb.halfW + 0.2 && dy < refHalfH + rb.halfH + 0.2
        })
      }
      if (checkCollision(refX, refY)) {
        const flipX = -refX
        const flipY = -refY
        if (checkCollision(flipX, flipY)) {
          refX = 0
          refY = 0
        } else {
          refX = flipX
          refY = flipY
        }
      }
      const { wx: refWx, wy: refWy } = localToWorld(refX, refY)
      placedRefBoxes.push({ wx: refWx, wy: refWy, halfW: refHalfW, halfH: refHalfH })
    }

    const footprintAtX = comp.center.x + pageOffset.x
    const footprintAtY = comp.center.y + pageOffset.y

    blocks.push(
      `  (footprint "${footprintValue}" (layer "${kicadLayer}")\n` +
      `    (uuid ${footprintUuid})\n` +
      `    (at ${footprintAtX.toFixed(4)} ${footprintAtY.toFixed(4)} ${rotDeg})\n` +
      `    (descr "Generated by my-project")\n` +
      `    (attr ${hasThruHole ? "through_hole" : "smd"})\n` +
      `    (property "Reference" "${refDes}"\n` +
      `      (at ${refX.toFixed(4)} ${refY.toFixed(4)} ${silkRef.ccw_rotation ?? 0})\n` +
      `      (layer "${silkLayer}")\n` +
      `      (uuid ${refUuid})\n` +
      `      (effects (font (size ${REF_FONT.toFixed(1)} ${REF_FONT.toFixed(1)}) (thickness 0.12)))\n` +
      `    )\n` +
      `    (property "Value" ""\n` +
      `      (at 0 ${(comp.height / 2 + 0.3).toFixed(4)} 0)\n` +
      `      (layer "Cmts.User")\n` +
      `      (uuid ${valUuid})\n` +
      `      (effects (font (size 0.6 0.6) (thickness 0.12)))\n` +
      `    )\n` +
      (padLines.length > 0 ? padLines.join("\n") + "\n" : "") +
      `  )\n`
    )
  }

  return blocks.join("\n")
}

/** Find the previous wire segment in the route array before index `from`. */
function findPrevWire(route: any[], from: number): any | null {
  for (let i = from - 1; i >= 0; i--) {
    if (route[i].route_type === "wire") return route[i]
  }
  return null
}

// Vias emitted from independent trace routes can land at points that are
// physically the same but differ in the 4th decimal place from floating-
// point drift. Round to a coarse grid (well under a via's own 0.6mm
// diameter) so those collapse into one via instead of two "co-located
// holes" DRC violations.
const VIA_DEDUP_GRID_MM = 0.05
function viaDedupKey(x: number, y: number, layerA: string, layerB: string, net: string): string {
  const gx = (Math.round(x / VIA_DEDUP_GRID_MM) * VIA_DEDUP_GRID_MM).toFixed(2)
  const gy = (Math.round(y / VIA_DEDUP_GRID_MM) * VIA_DEDUP_GRID_MM).toFixed(2)
  return `${net}_${gx}_${gy}_${[layerA, layerB].sort().join("_")}`
}

/** Find the next wire segment on the same layer after index `start`. */
function findNextSameLayerWire(route: any[], start: number, layer: string): any | null {
  for (let i = start; i < route.length; i++) {
    const seg = route[i]
    if (seg.route_type === "via") return null // via ends the layer run
    if (seg.route_type === "wire" && layerToKicad(seg.layer ?? "top") === layer) return seg
  }
  return null
}

function buildTraceSegments(
  circuitJson: AnyCircuitElement[],
  sourceNets: any[],
  pageOffset: { x: number; y: number },
): string {
  const pcbTraces = circuitJson.filter((e: any) => e.type === "pcb_trace") as any[]
  const netNameToIndex = new Map<string, number>()
  netNameToIndex.set("", 0)
  for (let i = 0; i < sourceNets.length; i++) {
    const net = sourceNets[i]
    const netName = net.name ?? net.source_net_id
    netNameToIndex.set(netName, i + 1)
    netNameToIndex.set(net.source_net_id, i + 1)
  }

  const segments: string[] = []
  let viaUuidCounter = 0
  const emittedViaPositions = new Set<string>()

  // Map source_net_id -> real net name (e.g., "source_net_7" -> "GND")
  const sourceNetIdToName = new Map<string, string>()
  for (const n of sourceNets) {
    sourceNetIdToName.set(n.source_net_id, n.name ?? n.source_net_id)
  }

  for (const trace of pcbTraces) {
    const route = trace.route as any[]
    if (!route || route.length === 0) continue

    const rawNetName = trace.connection_name ?? ""
    const resolvedNetName = sourceNetIdToName.get(rawNetName) ?? rawNetName
    const netIdx = netNameToIndex.get(resolvedNetName) ?? netNameToIndex.get(rawNetName) ?? 0
    const netLabel = `${netIdx}`

    // Emit wire segments and detect implicit layer changes that need a via.
    let currentLayer: string | null = null

    for (let i = 0; i < route.length; i++) {
      const seg = route[i]

      if (seg.route_type === "via") {
        const fromLayer = layerToKicad(seg.from_layer ?? "top")
        const toLayer = layerToKicad(seg.to_layer ?? "bottom")
        const viaKey = viaDedupKey(seg.x, seg.y, fromLayer, toLayer, netLabel)
        if (emittedViaPositions.has(viaKey)) {
          currentLayer = toLayer
          continue
        }
        emittedViaPositions.add(viaKey)
        const viaUuid = `via_${(viaUuidCounter++).toString(16).padStart(8, "0")}`
        segments.push(
          `  (via\n` +
          `    (at ${(seg.x + pageOffset.x).toFixed(4)} ${(seg.y + pageOffset.y).toFixed(4)})\n` +
          `    (size 0.6)\n` +
          `    (drill 0.3)\n` +
          `    (layers "${fromLayer}" "${toLayer}")\n` +
          `    (capping no)\n` +
          `    (covering (front no) (back no))\n` +
          `    (plugging (front no) (back no))\n` +
          `    (filling no)\n` +
          `    (net ${netLabel})\n` +
          `    (uuid ${viaUuid})\n` +
          `  )`
        )
        currentLayer = toLayer
        continue
      }

      if (seg.route_type !== "wire") continue

      const segLayer = layerToKicad(seg.layer ?? "top")

      // Detect implicit layer change: wire on a different layer than the
      // previous wire, with no explicit via between them.
      if (currentLayer !== null && segLayer !== currentLayer) {
        // Emit a via at the previous point's location to bridge the layers
        const prevWire = findPrevWire(route, i)
        if (prevWire) {
          const viaKey = viaDedupKey(prevWire.x, prevWire.y, currentLayer, segLayer, netLabel)
          if (!emittedViaPositions.has(viaKey)) {
            emittedViaPositions.add(viaKey)
            const viaUuid = `via_${(viaUuidCounter++).toString(16).padStart(8, "0")}`
            segments.push(
              `  (via\n` +
              `    (at ${(prevWire.x + pageOffset.x).toFixed(4)} ${(prevWire.y + pageOffset.y).toFixed(4)})\n` +
              `    (size 0.6)\n` +
              `    (drill 0.3)\n` +
              `    (layers "${currentLayer}" "${segLayer}")\n` +
              `    (capping no)\n` +
              `    (covering (front no) (back no))\n` +
              `    (plugging (front no) (back no))\n` +
              `    (filling no)\n` +
              `    (net ${netLabel})\n` +
              `    (uuid ${viaUuid})\n` +
              `  )`
            )
          }
        }
      }

      currentLayer = segLayer

      // Find the next wire segment on the same layer to emit a segment
      const nextWire = findNextSameLayerWire(route, i + 1, segLayer)
      if (nextWire) {
        // Skip zero-length segments
        if (Math.abs(seg.x - nextWire.x) > 1e-6 || Math.abs(seg.y - nextWire.y) > 1e-6) {
          const segUuid = `seg_${(viaUuidCounter++).toString(16).padStart(8, "0")}`
          segments.push(
            `  (segment\n` +
            `    (start ${(seg.x + pageOffset.x).toFixed(4)} ${(seg.y + pageOffset.y).toFixed(4)})\n` +
            `    (end ${(nextWire.x + pageOffset.x).toFixed(4)} ${(nextWire.y + pageOffset.y).toFixed(4)})\n` +
            `    (width 0.2)\n` +
            `    (layer "${segLayer}")\n` +
            `    (net ${netLabel})\n` +
            `    (uuid ${segUuid})\n` +
            `  )`
          )
        }
      }
    }
  }

  return segments.join("\n")
}

function buildBoardOutline(
  width: number,
  height: number,
  pageOffset: { x: number; y: number },
): string {
  const hw = width / 2
  const hh = height / 2
  const uuid = (i: number) => `edge_${i.toString(16).padStart(8, "0")}`
  const startX = pageOffset.x - hw
  const startY = pageOffset.y - hh
  const endX = pageOffset.x + hw
  const endY = pageOffset.y + hh
  return `  (gr_rect (start ${startX.toFixed(4)} ${startY.toFixed(4)}) (end ${endX.toFixed(4)} ${endY.toFixed(4)}) (stroke (width 0.05) (type solid)) (fill none) (layer "Edge.Cuts") (uuid ${uuid(0)}))`
}

// KiCad/KiCanvas always draws the page/title-block frame starting at world
// (0,0) in the page's top-left corner, regardless of where the board
// geometry sits. Board geometry is centered at world (0,0) (see
// centerPcbLayout in pcbRouting.ts), so without a page-space offset the
// board always renders pinned into the top-left corner instead of the page
// center. Size the page to the board plus a fixed margin, and translate
// every emitted coordinate so board-space (0,0) maps to the page center.
export const PCB_PAGE_MARGIN_MM = 20

export function computePcbPageGeometry(
  boardWidth: number,
  boardHeight: number,
): { paperWidth: number; paperHeight: number; pageOffset: { x: number; y: number } } {
  const paperWidth = boardWidth + PCB_PAGE_MARGIN_MM * 2
  const paperHeight = boardHeight + PCB_PAGE_MARGIN_MM * 2
  return { paperWidth, paperHeight, pageOffset: { x: paperWidth / 2, y: paperHeight / 2 } }
}

export function circuitJsonToKicadPcb(circuitJson: AnyCircuitElement[]): string {
  const board = circuitJson.find((e: any) => e.type === "pcb_board") as any
  const sourceNets = circuitJson.filter((e: any) => e.type === "source_net") as any[]

  if (!board) {
    throw new Error("circuitJsonToKicadPcb: no pcb_board element found")
  }

  const generator = getGeneratorName()
  const layerCount = board.num_layers ?? 2
  const boardWidth = board.width ?? 80
  const boardHeight = board.height ?? 60

  const { paperWidth, paperHeight, pageOffset } = computePcbPageGeometry(boardWidth, boardHeight)

  const layersSection = buildLayersSection(layerCount)
  const setupSection = buildSetupSection()
  const netSection = buildNetSection(sourceNets)
  const footprintBlocks = buildFootprintBlocks(circuitJson, sourceNets, pageOffset)
  const traceSegments = buildTraceSegments(circuitJson, sourceNets, pageOffset)
  const boardOutline = buildBoardOutline(boardWidth, boardHeight, pageOffset)

  const generalSection = `  (general
    (thickness ${board.thickness ?? 1.6})
    (legacy_teardrops no)
  )`

  return `(kicad_pcb (version 20260206) (generator "${generator}")
  (generator_version "10.0")
${generalSection}
  (paper "User" ${paperWidth.toFixed(4)} ${paperHeight.toFixed(4)})
  (title_block
    (title "")
    (date "")
    (rev "")
    (company "")
    (comment 1 "")
    (comment 2 "")
    (comment 3 "")
    (comment 4 "")
    (comment 5 "")
    (comment 6 "")
    (comment 7 "")
    (comment 8 "")
    (comment 9 "")
  )
${layersSection}
${setupSection}

${netSection}

${boardOutline}

${footprintBlocks}

${traceSegments}
)`
}
