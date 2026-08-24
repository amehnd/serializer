import {
  AutoroutingPipelineSolver,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter";

export interface RoutedTrace {
  route: Array<
    | { route_type: "wire"; x: number; y: number; width: number; layer: string }
    | {
        route_type: "via";
        x: number;
        y: number;
        to_layer: string;
        from_layer: string;
      }
  >;
}

export interface RouteCircuitResult {
  success: boolean;
  traces: RoutedTrace[];
  error?: string;
}

function convertSimplifiedPcbTraces(traces: SimplifiedPcbTrace[]): RoutedTrace[] {
  const result: RoutedTrace[] = [];

  for (const trace of traces) {
    const route: RoutedTrace["route"] = [];

    for (const segment of trace.route) {
      if (segment.route_type === "wire") {
        route.push({
          route_type: "wire",
          x: segment.x,
          y: segment.y,
          width: segment.width,
          layer: segment.layer,
        });
      } else if (segment.route_type === "via") {
        route.push({
          route_type: "via",
          x: segment.x,
          y: segment.y,
          to_layer: segment.to_layer,
          from_layer: segment.from_layer,
        });
      }
    }

    if (route.length > 0) {
      result.push({ route: snapRouteToManhattan(route) });
    }
  }

  return result;
}

function snapRouteToManhattan(route: RoutedTrace["route"]): RoutedTrace["route"] {
  const out: RoutedTrace["route"] = [];

  for (let i = 0; i < route.length; i++) {
    const seg = route[i];

    if (seg.route_type === "via") {
      out.push(seg);
      continue;
    }

    const nextWire = findNextWireOnLayer(route, i + 1, seg.layer);
    if (!nextWire) {
      out.push(seg);
      continue;
    }

    const dx = Math.abs(nextWire.x - seg.x);
    const dy = Math.abs(nextWire.y - seg.y);

    if (dx < 1e-6 || dy < 1e-6) {
      out.push(seg);
      continue;
    }

    // Diagonal — split into L-shape (horizontal first, then vertical)
    out.push({ ...seg });
    out.push({
      ...seg,
      x: nextWire.x,
      y: seg.y,
    });
    out.push({
      ...seg,
      x: nextWire.x,
      y: nextWire.y,
    });
  }

  return out;
}

function findNextWireOnLayer(
  route: RoutedTrace["route"],
  start: number,
  layer: string,
): RoutedTrace["route"][number] | null {
  for (let i = start; i < route.length; i++) {
    const seg = route[i];
    if (seg.route_type === "via") return null;
    if (seg.route_type === "wire" && seg.layer === layer) return seg;
  }
  return null;
}

export async function routeCircuit(
  simpleRouteJson: SimpleRouteJson,
): Promise<RouteCircuitResult> {
  try {
    // CapacityMeshSolver (AutoroutingPipelineSolver2_PortPointPathing) is
    // deprecated by the library itself in favor of AutoroutingPipelineSolver
    // (pipeline 7 / MultiGraph), which adds DRC-aware repair/improve stages
    // (GlobalDrcForceImproveSolver, HighDensityForceImproveSolver, etc.) that
    // the deprecated pipeline never had. NOTE: effort:2 was tried and made
    // things worse for the astracomputer fixture — the solver's internal
    // repair loop hit "ran out of iterations" and aborted early, producing a
    // much smaller/incomplete route set. Keep effort at 1 until that's
    // understood; it is not a free quality dial for this solver version.
    const solver = new AutoroutingPipelineSolver(simpleRouteJson, {
      effort: 1,
    });

    solver.solve();

    const output = solver.getOutputSimplifiedPcbTraces();

    if (!output || output.length === 0) {
      return {
        success: false,
        traces: [],
        error: "No routes found - circuit may be unroutable",
      };
    }

    const traces = convertSimplifiedPcbTraces(output);

    return {
      success: true,
      traces,
    };
  } catch (err) {
    return {
      success: false,
      traces: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
