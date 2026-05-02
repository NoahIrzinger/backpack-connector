import { Backpack } from "backpack-ontology";
import type { ConnectorAdapter } from "./adapter.js";
import { sanitizeDatabaseName } from "./database-name.js";

export interface CrossGraphEntity {
  label: string;
  type: string;
  appearances: Array<{
    graph: string;
    bkId: string;
    type: string;
    properties: Record<string, unknown>;
  }>;
}

export interface CrossGraphSignalReport {
  analyzedGraphs: string[];
  duplicateEntities: CrossGraphEntity[];
  totalDuplicates: number;
  summary: string;
}

function extractLabel(properties: Record<string, unknown>): string {
  for (const v of Object.values(properties)) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

export async function detectCrossGraphSignals(
  adapter: ConnectorAdapter,
  options: {
    graphs?: string[];
    backpackPath?: string;
    threshold?: number;
  } = {},
): Promise<CrossGraphSignalReport> {
  const threshold = options.threshold ?? 2;

  let graphs: string[];
  if (options.graphs && options.graphs.length > 0) {
    graphs = options.graphs;
  } else {
    const backpack = await Backpack.fromActiveBackpack();
    const summaries = await backpack.listOntologies();
    const projected: string[] = [];
    for (const s of summaries) {
      if (await adapter.databaseExists(sanitizeDatabaseName(s.name))) {
        projected.push(s.name);
      }
    }
    graphs = projected;
  }

  if (graphs.length < 2) {
    return {
      analyzedGraphs: graphs,
      duplicateEntities: [],
      totalDuplicates: 0,
      summary: "Need at least 2 projected graphs to detect cross-graph duplicates.",
    };
  }

  const labelIndex = new Map<
    string,
    Map<string, Array<{ bkId: string; type: string; label: string; properties: Record<string, unknown> }>>
  >();

  for (const graph of graphs) {
    const database = sanitizeDatabaseName(graph);
    if (!(await adapter.databaseExists(database))) continue;

    let rows: Record<string, unknown>[];
    try {
      const raw = await adapter.execute(database, "opencypher", "MATCH (n) WHERE n.bk_id IS NOT NULL RETURN n");
      rows = raw.map((r) => (r.n ?? r) as Record<string, unknown>);
    } catch {
      continue;
    }

    for (const row of rows) {
      const bkId = String(row.bk_id ?? "");
      if (!bkId) continue;

      const type = typeof row.bk_type === "string" && row.bk_type
        ? row.bk_type
        : typeof row["@type"] === "string"
        ? row["@type"]
        : "Unknown";

      const properties: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k.startsWith("@") || k.startsWith("_") || k.startsWith("bk_")) continue;
        if (v !== null && v !== undefined) properties[k] = v;
      }

      const label = extractLabel(properties);
      if (!label) continue;

      const normalized = label.toLowerCase().trim();
      if (!labelIndex.has(normalized)) labelIndex.set(normalized, new Map());
      const byGraph = labelIndex.get(normalized)!;
      if (!byGraph.has(graph)) byGraph.set(graph, []);
      byGraph.get(graph)!.push({ bkId, type, label, properties });
    }
  }

  const duplicates: CrossGraphEntity[] = [];
  for (const [, byGraph] of labelIndex) {
    if (byGraph.size < threshold) continue;

    const appearances: CrossGraphEntity["appearances"] = [];
    let firstType = "Unknown";
    let firstLabel = "";

    for (const [graph, nodes] of byGraph) {
      for (const node of nodes) {
        if (!firstLabel) { firstLabel = node.label; firstType = node.type; }
        appearances.push({ graph, bkId: node.bkId, type: node.type, properties: node.properties });
      }
    }
    duplicates.push({ label: firstLabel, type: firstType, appearances });
  }

  duplicates.sort((a, b) => b.appearances.length - a.appearances.length);

  const summary = duplicates.length === 0
    ? `No entities found appearing in ${threshold}+ graphs. Your graphs may be about distinct topics.`
    : `Found ${duplicates.length} entities appearing in ${threshold}+ graphs. ` +
      `Top: "${duplicates[0].label}" in ${new Set(duplicates[0].appearances.map((a) => a.graph)).size} graphs. ` +
      `These are Curiosity Engine candidates.`;

  return { analyzedGraphs: graphs, duplicateEntities: duplicates, totalDuplicates: duplicates.length, summary };
}
