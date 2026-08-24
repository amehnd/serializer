import type { AnyCircuitElement } from "circuit-json"
import type { SimpleRouteJson, Obstacle, SimpleRouteConnection } from "@tscircuit/capacity-autorouter"
import { routeCircuit, type RoutedTrace } from "./router"

const DEFAULT_MIN_TRACE_WIDTH = 0.15
const DEFAULT_NOMINAL_TRACE_WIDTH = 0.2
const COLLINEAR_EPSILON = 1e-6

export function circuitJsonToSimpleRouteJson(circuitJson: AnyCircuitElement[]): SimpleRouteJson {
  const board = circuitJson.find((e: any) => e.type === "pcb_board") as any
  const pcbComponents = circuitJson.filter((e: any) => e.type === "pcb_component") as any[]
  const pcbPorts = circuitJson.filter((e: any) => e.type === "pcb_port") as any[]
  const sourcePorts = circuitJson.filter((e: any) => e.type === "source_port") as any[]
  const sourceNets = circuitJson.filter((e: any) => e.type === "source_net") as any[]
  const sourceTraces = circuitJson.filter((e: any) => e.type === "source_trace") as any[]

  const boardWidth = board?.width ?? 80
  const boardHeight = board?.height ?? 60
  const layerCount = board?.num_layers ?? 2
  const minTraceWidth = board?.min_trace_width ?? DEFAULT_MIN_TRACE_WIDTH
  const bounds = {
    minX: -(boardWidth / 2),
    maxX: boardWidth / 2,
    minY: -(boardHeight / 2),
    maxY: boardHeight / 2,
  }

  // Build obstacles from pcb_components
  const obstacles: Obstacle[] = pcbComponents
    .filter((c) => c.obstructs_within_bounds !== false)
    .filter(Boolean)
    .map((c) => {
      const opId = c.pcb_component_id
      const opType = "rect" as const
      const opLayers = c.layer === "top" ? ["top"] : c.layer === "bottom" ? ["bottom"] : [c.layer]
      const opCenter = { x: c.center.x, y: c.center.y }
      const opWidth = c.width
      const opHeight = c.height
      const opConnectedTo: string[] = []
      return {
        obstacleId: opId,
        type: opType,
        layers: opLayers,
        center: opCenter,
        width: opWidth,
        height: opHeight,
        connectedTo: opConnectedTo,
      } as Obstacle
    })

  // Build pad-level obstacles so the autorouter maintains clearance from
  // pads belonging to other nets. Each pad obstacle's connectedTo contains
  // the net name, allowing only that net to route through the pad area.
  const smtpads = circuitJson.filter((e: any) => e.type === "pcb_smtpad") as any[]
  const platedHoles = circuitJson.filter((e: any) => e.type === "pcb_plated_hole") as any[]
  const pcbCompById = new Map(pcbComponents.map((c: any) => [c.pcb_component_id, c]))
  const portByPcbPortId = new Map(pcbPorts.map((p: any) => [p.pcb_port_id, p]))
  const traceBySrcPortId = new Map<string, any>()
  for (const st of sourceTraces) {
    for (const spId of (st.connected_source_port_ids || [])) {
      traceBySrcPortId.set(spId, st)
    }
  }
  const netIdToName = new Map(sourceNets.map((n: any) => [n.source_net_id, n.name]))

  const allPads = [...smtpads, ...platedHoles]
  for (const pad of allPads) {
    const port = portByPcbPortId.get(pad.pcb_port_id)
    if (!port?.source_port_id) continue
    const trace = traceBySrcPortId.get(port.source_port_id)
    const netName = trace?.connected_source_net_ids?.length
      ? (netIdToName.get(trace.connected_source_net_ids[0]) ?? "")
      : ""
    if (!netName) continue

    const comp = pcbCompById.get(pad.pcb_component_id)
    const layer = comp?.layer === "top" ? ["top"] : comp?.layer === "bottom" ? ["bottom"] : ["top"]

    let pWidth = pad.width ?? 0.6
    let pHeight = pad.height ?? 0.6
    if (pad.type === "pcb_plated_hole") {
      if (pad.shape === "circular_hole_with_rect_pad") {
        pWidth = pad.rect_pad_width ?? 1.7
        pHeight = pad.rect_pad_height ?? 1.7
      } else {
        const d = pad.outer_diameter ?? 1.7
        pWidth = d
        pHeight = d
      }
    }

    const obsId = pad.type === "pcb_plated_hole" ? pad.pcb_plated_hole_id : pad.pcb_smtpad_id

    obstacles.push({
      obstacleId: `pad_${obsId}`,
      type: "rect",
      layers: layer,
      center: { x: pad.x, y: pad.y },
      width: pWidth + 0.4,  // Add clearance margin (KiCad requires 0.2mm clearance + 0.2mm track half-width)
      height: pHeight + 0.4,
      connectedTo: [netName],
    } as Obstacle)
  }

  // Build source_port lookup: source_port_id -> source_port
  const sourcePortMap = new Map<string, any>()
  for (const sp of sourcePorts) {
    sourcePortMap.set(sp.source_port_id, sp)
  }

  // Build pcb_port lookup: pcb_port_id -> pcb_port
  const pcbPortMap = new Map<string, any>()
  for (const pp of pcbPorts) {
    pcbPortMap.set(pp.pcb_port_id, pp)
  }

  // Map source_port_id -> pcb_port (via source_port_id field on pcb_port)
  const sourceToPcbPort = new Map<string, any>()
  for (const pp of pcbPorts) {
    if (pp.source_port_id) {
      sourceToPcbPort.set(pp.source_port_id, pp)
    }
  }

  // For each source_net, collect all connected pcb_ports
  const connections: SimpleRouteConnection[] = []
  for (const net of sourceNets) {
    const connectedPortIds = new Set<string>()
    for (const trace of sourceTraces) {
      if (trace.connected_source_net_ids?.includes(net.source_net_id)) {
        for (const portId of trace.connected_source_port_ids || []) {
          connectedPortIds.add(portId)
        }
      }
    }

    const pointsToConnect: SimpleRouteConnection["pointsToConnect"] = []
    for (const portId of connectedPortIds) {
      const pcbPort = sourceToPcbPort.get(portId)
      if (pcbPort) {
        const layer = (pcbPort.layers?.[0] as string) ?? "top"
        pointsToConnect.push({
          x: pcbPort.x,
          y: pcbPort.y,
          layer,
          pointId: pcbPort.pcb_port_id,
        })
      }
    }

    if (pointsToConnect.length >= 2) {
      connections.push({
        name: net.name ?? net.source_net_id,
        pointsToConnect,
      })
    }
  }

  const simpleRouteJson: SimpleRouteJson = {
    layerCount,
    minTraceWidth,
    nominalTraceWidth: DEFAULT_NOMINAL_TRACE_WIDTH,
    minViaPadDiameter: board?.min_via_pad_diameter ?? 0.3,
    min_via_pad_diameter: board?.min_via_pad_diameter ?? 0.3,
    minViaHoleDiameter: board?.min_via_hole_diameter ?? 0.2,
    min_via_hole_diameter: board?.min_via_hole_diameter ?? 0.2,
    defaultObstacleMargin: 0.35,
    minTraceToPadEdgeClearance: board?.min_trace_to_pad_edge_clearance ?? 0.25,
    obstacles,
    connections,
    bounds,
    allowJumpers: false,
  }

  return simpleRouteJson
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * Match solver traces to connection names by comparing endpoint positions.
 * The CapacityMeshSolver may reorder traces internally, so index-based
 * assignment is unreliable.  This function finds the best permutation.
 */
function matchTracesToNames(
  routedTraces: RoutedTrace[],
  connectionNames: string[],
  pointsToConnect: { name: string; points: { x: number; y: number }[] }[],
): string[] {
  const n = routedTraces.length
  const result = new Array<string>(n)
  const used = new Set<number>()

  for (let i = 0; i < n; i++) {
    const route = routedTraces[i].route
    const first = route[0]
    const last = route[route.length - 1]

    let bestIdx = -1
    let bestDist = Infinity
    for (let j = 0; j < pointsToConnect.length; j++) {
      if (used.has(j)) continue
      const pts = pointsToConnect[j].points
      if (pts.length < 2) continue
      const d = Math.min(
        dist(first, pts[0]) + dist(last, pts[1]),
        dist(first, pts[1]) + dist(last, pts[0]),
      )
      if (d < bestDist) {
        bestDist = d
        bestIdx = j
      }
    }
    result[i] = bestIdx >= 0 ? pointsToConnect[bestIdx].name : `routed_net_${i}`
    if (bestIdx >= 0) used.add(bestIdx)
  }

  return result
}

export function mergeRoutedTraces(
  circuitJson: AnyCircuitElement[],
  routedTraces: RoutedTrace[],
  connectionNames?: string[],
  simpleRouteJson?: any,
): AnyCircuitElement[] {
  const result = [...circuitJson]

  // Build name list, matching solver output order to connection order
  let names: string[]
  if (connectionNames && simpleRouteJson?.connections) {
    const pts = simpleRouteJson.connections.map((c: any) => ({
      name: c.name,
      points: c.pointsToConnect as { x: number; y: number }[],
    }))
    names = matchTracesToNames(routedTraces, connectionNames, pts)
  } else if (connectionNames) {
    names = [...connectionNames]
    // Pad or trim to match trace count
    while (names.length < routedTraces.length) names.push(`routed_net_${names.length}`)
    names.length = routedTraces.length
  } else {
    names = routedTraces.map((_, i) => `routed_net_${i}`)
  }

  // Remove old pcb_trace entries (the placeholder/ratsnest traces)
  const filtered = result.filter((e: any) => e.type !== "pcb_trace")

  // Add new routed traces as pcb_trace elements
  for (let i = 0; i < routedTraces.length; i++) {
    const routed = routedTraces[i]
    filtered.push({
      type: "pcb_trace",
      pcb_trace_id: `routed_trace_${i}`,
      connection_name: names[i],
      route: routed.route.map((seg) => {
        if (seg.route_type === "wire") {
          return {
            route_type: "wire",
            x: seg.x,
            y: seg.y,
            width: seg.width,
            layer: seg.layer,
          }
        }
        return {
          route_type: "via",
          x: seg.x,
          y: seg.y,
          to_layer: seg.to_layer,
          from_layer: seg.from_layer,
        }
      }),
    } as AnyCircuitElement)
  }

  return filtered
}

/**
 * Minimum courtyard clearance between any two PCB components (mm).
 * Components closer than this will be pushed apart along the axis of overlap.
 */
const MIN_PLACEMENT_CLEARANCE_MM = 0.5

/**
 * Enforce minimum clearance between PCB component footprints by nudging
 * overlapping components apart along the axis of maximum overlap.
 * Returns a new array (does not mutate the input).
 */
export function enforcePlacementClearance(circuitJson: AnyCircuitElement[]): AnyCircuitElement[] {
  const result = circuitJson.map((e) => ({ ...e }))
  const components = result.filter((e: any) => e.type === "pcb_component") as any[]

  // Sort by x then y for deterministic ordering
  components.sort((a: any, b: any) =>
    a.center.x !== b.center.x ? a.center.x - b.center.x : a.center.y - b.center.y,
  )

  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const a = components[i]
      const b = components[j]
      if (!a?.center || !b?.center) continue

      const hwA = (a.width ?? 1) / 2 + MIN_PLACEMENT_CLEARANCE_MM / 2
      const hhA = (a.height ?? 1) / 2 + MIN_PLACEMENT_CLEARANCE_MM / 2
      const hwB = (b.width ?? 1) / 2 + MIN_PLACEMENT_CLEARANCE_MM / 2
      const hhB = (b.height ?? 1) / 2 + MIN_PLACEMENT_CLEARANCE_MM / 2

      const dx = b.center.x - a.center.x
      const dy = b.center.y - a.center.y
      const overlapX = (hwA + hwB) - Math.abs(dx)
      const overlapY = (hhA + hhB) - Math.abs(dy)

      if (overlapX > 0 && overlapY > 0) {
        // Push apart along the axis of minimum overlap (smallest push distance).
        // hwA/hwB already include clearance/2, so desired center-to-center = hwA + hwB.
        if (overlapX < overlapY) {
          const push = (hwA + hwB) - Math.abs(dx)
          const dir = dx >= 0 ? 1 : -1
          b.center = { ...b.center, x: b.center.x + push * dir }
        } else {
          const push = (hhA + hhB) - Math.abs(dy)
          const dir = dy >= 0 ? 1 : -1
          b.center = { ...b.center, y: b.center.y + push * dir }
        }
      }
    }
  }

  return result
}

export async function routeCircuitJson(
  circuitJson: AnyCircuitElement[],
): Promise<{ circuitJson: AnyCircuitElement[]; success: boolean; error?: string }> {
  // Enforce minimum clearance before routing
  const clearedCircuitJson = enforcePlacementClearance(circuitJson)
  const simpleRouteJson = circuitJsonToSimpleRouteJson(clearedCircuitJson)
  const result = await routeCircuit(simpleRouteJson)

  if (!result.success) {
    return { circuitJson, success: false, error: result.error }
  }

  const connectionNames = simpleRouteJson.connections.map((c: any) => c.name)
  const merged = mergeRoutedTraces(clearedCircuitJson, result.traces, connectionNames, simpleRouteJson)
  return { circuitJson: merged, success: true }
}

/**
 * Chamfer all 90-degree corners in pcb_trace routes to 45-degree corners.
 * Each Manhattan (L-shaped) corner is replaced with a 45-degree chamfered
 * pair of points, producing a smooth octagonal-looking trace.
 * Vias and layer transitions are preserved.
 */
export function chamferCircuitJsonTracesTo45Degree(
  circuitJson: AnyCircuitElement[],
): AnyCircuitElement[] {
  return circuitJson.map((el: any) => {
    if (el.type !== "pcb_trace" || !Array.isArray(el.route)) return el
    return { ...el, route: chamferTraceRoute(el.route) }
  })
}

const CHAMFER_FACTOR = 1 / 3

function chamferTraceRoute(route: any[]): any[] {
  if (route.length < 3) return route

  const out: any[] = []
  let i = 0

  while (i < route.length) {
    const seg = route[i]

    if (seg.route_type === "via") {
      out.push(seg)
      i++
      continue
    }

    // Find the end of the current same-layer wire run
    const runLayer = seg.layer
    let runEnd = i + 1
    while (runEnd < route.length) {
      const s = route[runEnd]
      if (s.route_type === "via") break
      if (s.route_type === "wire" && s.layer === runLayer) {
        runEnd++
      } else {
        break
      }
    }

    // Collect points in this run
    const points: any[] = []
    for (let j = i; j < runEnd; j++) {
      points.push({ ...route[j] })
    }

    const chamfered = chamferPoints(points)

    for (const p of chamfered) {
      out.push(p)
    }

    i = runEnd
  }

  return out
}

function chamferPoints(points: any[]): any[] {
  if (points.length < 3) return points

  const result: any[] = []
  result.push({ ...points[0] })

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]
    const curr = points[i]
    const next = points[i + 1]

    const dx0 = curr.x - prev.x
    const dy0 = curr.y - prev.y
    const dx1 = next.x - curr.x
    const dy1 = next.y - curr.y

    const horiz0 = Math.abs(dy0) < 1e-6 && Math.abs(dx0) > 1e-6
    const vert0 = Math.abs(dx0) < 1e-6 && Math.abs(dy0) > 1e-6
    const horiz1 = Math.abs(dy1) < 1e-6 && Math.abs(dx1) > 1e-6
    const vert1 = Math.abs(dx1) < 1e-6 && Math.abs(dy1) > 1e-6

    const isCorner = (horiz0 && vert1) || (vert0 && horiz1)

    if (!isCorner) {
      result.push({ ...curr })
      continue
    }

    const len0 = Math.abs(dx0) + Math.abs(dy0)
    const len1 = Math.abs(dx1) + Math.abs(dy1)
    const chamfer = Math.min(len0, len1) * CHAMFER_FACTOR
    if (chamfer < 0.001) {
      result.push({ ...curr })
      continue
    }

    const sx0 = dx0 > 0 ? 1 : dx0 < 0 ? -1 : 0
    const sy0 = dy0 > 0 ? 1 : dy0 < 0 ? -1 : 0
    const sx1 = dx1 > 0 ? 1 : dx1 < 0 ? -1 : 0
    const sy1 = dy1 > 0 ? 1 : dy1 < 0 ? -1 : 0

    const d = { ...curr, x: curr.x - sx0 * chamfer, y: curr.y - sy0 * chamfer }
    const e = { ...curr, x: curr.x + sx1 * chamfer, y: curr.y + sy1 * chamfer }

    result.push(d)
    result.push(e)
  }

  result.push({ ...points[points.length - 1] })
  return result
}

const KICAD_CLEARANCE_MM = 0.25 // 0.2 clearance + 0.05 solder mask expansion

function closestPointOnSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): { x: number; y: number; t: number } {
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq < 0.000001) return { x: ax, y: ay, t: 0 }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return { x: ax + t * dx, y: ay + t * dy, t }
}

function distToRect(
  rx: number, ry: number, rw: number, rh: number,
  px: number, py: number,
): number {
  const cx = Math.max(rx - rw, Math.min(px, rx + rw))
  const cy = Math.max(ry - rh, Math.min(py, ry + rh))
  return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2)
}

export function enforceTracePadClearance(
  circuitJson: AnyCircuitElement[],
): AnyCircuitElement[] {
  const smtpads = circuitJson.filter((e: any) => e.type === "pcb_smtpad") as any[]
  const pcbPorts = circuitJson.filter((e: any) => e.type === "pcb_port") as any[]
  const sourceTraces = circuitJson.filter((e: any) => e.type === "source_trace") as any[]
  const sourceNets = circuitJson.filter((e: any) => e.type === "source_net") as any[]

  const portByPcbPortId = new Map(pcbPorts.map((p: any) => [p.pcb_port_id, p]))
  const traceBySrcPortId = new Map<string, any>()
  for (const st of sourceTraces) {
    for (const spId of (st.connected_source_port_ids || [])) {
      traceBySrcPortId.set(spId, st)
    }
  }
  const netIdToName = new Map(sourceNets.map((n: any) => [n.source_net_id, n.name]))

  const padData = smtpads.map((pad: any) => {
    const port = portByPcbPortId.get(pad.pcb_port_id)
    const trace = port?.source_port_id ? traceBySrcPortId.get(port.source_port_id) : null
    const netId = trace?.connected_source_net_ids?.[0] ?? ""
    const netName = netIdToName.get(netId) ?? ""
    return {
      x: pad.x,
      y: pad.y,
      w: (pad.width ?? 0.6) / 2,
      h: (pad.height ?? 0.6) / 2,
      net: netName,
      clearance: KICAD_CLEARANCE_MM,
    }
  })

  return circuitJson.map((el: any) => {
    if (el.type !== "pcb_trace" || !Array.isArray(el.route)) return el
    const traceNetId = el.connection_name ?? ""
    const trackNet = netIdToName.get(traceNetId) ?? traceNetId

    const wires = el.route.filter((s: any) => s.route_type === "wire" && s.layer === "top")
    if (wires.length <= 1) return el

    let totalPushX = 0, totalPushY = 0
    let found = false

    for (let idx = 0; idx < el.route.length; idx++) {
      const seg = el.route[idx]
      if (seg.route_type !== "wire" || seg.layer !== "top") continue

      let nextWire: any = null
      for (let j = idx + 1; j < el.route.length; j++) {
        if (el.route[j].route_type === "via") break
        if (el.route[j].route_type === "wire" && el.route[j].layer === seg.layer) {
          nextWire = el.route[j]
          break
        }
      }

      const sx = seg.x, sy = seg.y
      const ex = nextWire ? nextWire.x : sx
      const ey = nextWire ? nextWire.y : sy
      const halfWidth = (seg.width ?? 0.2) / 2

      // Segments may be Manhattan (vertical/horizontal) or 45-degree
      // chamfered diagonals — clearance must be enforced against both, or
      // chamfered corners can cut across a neighboring pad unchecked.
      for (const pad of padData) {
        if (pad.net === trackNet) continue

        const cp = closestPointOnSegment(pad.x, pad.y, sx, sy, ex, ey)
        const cpDist = distToRect(pad.x, pad.y, pad.w, pad.h, cp.x, cp.y)
        const dStart = distToRect(pad.x, pad.y, pad.w, pad.h, sx, sy)
        const minDist = Math.min(cpDist, dStart)
        const requiredDist = halfWidth + pad.clearance

        if (minDist < requiredDist && minDist > 0.0001) {
          const push = requiredDist - minDist
          // Push direction: away from the pad, along the vector from the
          // pad center to the closest point on the segment. This reduces
          // to the old sign-of-axis-difference behavior for pure
          // vertical/horizontal segments, and generalizes cleanly to
          // diagonal (chamfered) ones.
          let vx = cp.x - pad.x
          let vy = cp.y - pad.y
          const vlen = Math.sqrt(vx * vx + vy * vy)
          if (vlen < 1e-6) { vx = sx >= pad.x ? 1 : -1; vy = 0 } else { vx /= vlen; vy /= vlen }
          const pushX = vx * push
          const pushY = vy * push

          if (!found || totalPushX === 0 || Math.sign(pushX) === Math.sign(totalPushX)) {
            totalPushX = Math.sign(totalPushX || pushX) * Math.max(Math.abs(totalPushX), Math.abs(pushX))
          }
          if (!found || totalPushY === 0 || Math.sign(pushY) === Math.sign(totalPushY)) {
            totalPushY = Math.sign(totalPushY || pushY) * Math.max(Math.abs(totalPushY), Math.abs(pushY))
          }
          found = true
        }
      }
    }

    if (!found) return el

    const route = el.route.map((seg: any) => {
      if (seg.route_type !== "wire" || seg.layer !== "top") return seg
      return { ...seg, x: seg.x + totalPushX, y: seg.y + totalPushY }
    })

    return { ...el, route }
  })
}

export function removeZeroLengthSegments(circuitJson: AnyCircuitElement[]): AnyCircuitElement[] {
  return circuitJson.map((el: any) => {
    if (el.type !== "pcb_trace" || !Array.isArray(el.route)) return el
    const route = el.route
    const out: any[] = []
    for (let i = 0; i < route.length; i++) {
      const seg = route[i]
      if (seg.route_type !== "wire") { out.push(seg); continue }
      const next = i + 1 < route.length ? route[i + 1] : null
      if (next && next.route_type === "wire") {
        const dx = Math.abs(seg.x - next.x)
        const dy = Math.abs(seg.y - next.y)
        if (dx < 0.0001 && dy < 0.0001) continue // zero-length, skip
      }
      out.push(seg)
    }
    return { ...el, route: out }
  })
}

// Translate all PCB-positioned elements so the copper content's bounding box
// is centered on the board (CircuitRunner auto-placement clusters content near
// the origin regardless of board size).
export function centerPcbLayout(circuitJson: AnyCircuitElement[]): AnyCircuitElement[] {
  const xs: number[] = []
  const ys: number[] = []
  const positioned = (el: any): boolean => {
    if (el.type === "pcb_component") return (el.center != null && Number.isFinite(el.center.x) && Number.isFinite(el.center.y))
    if (el.type === "pcb_smtpad" || el.type === "pcb_plated_hole" || el.type === "pcb_port" || el.type === "pcb_via")
      return Number.isFinite(el.x) && Number.isFinite(el.y)
    return false
  }
  const xOf = (el: any): number | null => el.type === "pcb_component" ? el.center.x : el.x
  const yOf = (el: any): number | null => el.type === "pcb_component" ? el.center.y : el.y
  for (const el of circuitJson as any[]) {
    if (el.type === "pcb_trace" && Array.isArray(el.route)) {
      for (const seg of el.route) {
        if (seg && Number.isFinite(seg.x) && Number.isFinite(seg.y)) { xs.push(seg.x); ys.push(seg.y) }
      }
    } else if (positioned(el)) {
      xs.push(xOf(el) as number)
      ys.push(yOf(el) as number)
    }
  }
  if (xs.length === 0) return circuitJson
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const dx = -(minX + maxX) / 2
  const dy = -(minY + maxY) / 2
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return circuitJson
  return circuitJson.map((el: any) => {
    if (positioned(el)) {
      const nx = (xOf(el) as number) + dx
      const ny = (yOf(el) as number) + dy
      if (el.type === "pcb_component") return { ...el, center: { ...el.center, x: nx, y: ny } }
      return { ...el, x: nx, y: ny }
    }
    if (el.type === "pcb_trace" && Array.isArray(el.route)) {
      return {
        ...el,
        route: el.route.map((seg: any) =>
          seg && Number.isFinite(seg.x) && Number.isFinite(seg.y)
            ? { ...seg, x: seg.x + dx, y: seg.y + dy }
            : seg,
        ),
      }
    }
    return el
  })
}

export function mergeCollinearSegments(circuitJson: AnyCircuitElement[]): AnyCircuitElement[] {
  return circuitJson.map((el: any) => {
    if (el.type !== "pcb_trace" || !Array.isArray(el.route)) return el
    const route = [...el.route]
    const out: any[] = []
    for (const seg of route) {
      out.push(seg)
      while (out.length >= 3) {
        const c = out[out.length - 1]
        const b = out[out.length - 2]
        const a = out[out.length - 3]
        if (
          a.route_type !== "wire" ||
          b.route_type !== "wire" ||
          c.route_type !== "wire" ||
          a.layer !== b.layer ||
          b.layer !== c.layer
        ) {
          break
        }
        const cross =
          (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
        if (Math.abs(cross) > COLLINEAR_EPSILON) break
        out.splice(out.length - 2, 1)
      }
    }
    return { ...el, route: out }
  })
}
