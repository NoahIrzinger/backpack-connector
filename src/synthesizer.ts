import { Backpack } from "backpack-ontology";
import type { Node, Edge, LearningGraphData } from "backpack-ontology/connector";
import type { ConnectorAdapter } from "./adapter.js";
import { project } from "./projector.js";
import { sanitizeDatabaseName } from "./database-name.js";

export interface SynthesizeOptions {
  backpackPath: string;
  graphs: string[];
  into: string;
  branch?: string;
  reset?: boolean;
  projectFirst?: boolean;
}

export interface SynthesizeResult {
  outputGraph: string;
  nodeCount: number;
  edgeCount: number;
  sourceGraphs: string[];
  durationMs: number;
  viewerUrl: string;
}

function rowToNode(row: Record<string, unknown>): Node | null {
  const bkId = row.bk_id;
  if (typeof bkId !== "string" || !bkId) return null;

  const type = typeof row.bk_type === "string" && row.bk_type
    ? row.bk_type
    : typeof row["@type"] === "string"
    ? row["@type"]
    : "Unknown";

  const createdAt = String(row.bk_created_at ?? new Date().toISOString());
  const updatedAt = String(row.bk_updated_at ?? new Date().toISOString());

  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("@") || k.startsWith("_")) continue;
    if (k === "bk_graph" || k === "bk_branch") { properties[k] = v; continue; }
    if (k.startsWith("bk_")) continue;
    if (v !== null && v !== undefined) properties[k] = v;
  }

  return { id: bkId, type, properties, createdAt, updatedAt };
}

function rowToEdge(row: Record<string, unknown>): Edge | null {
  const bkId = row.bk_id;
  const sourceId = row.source_id;
  const targetId = row.target_id;
  if (
    typeof bkId !== "string" || !bkId ||
    typeof sourceId !== "string" || !sourceId ||
    typeof targetId !== "string" || !targetId
  ) return null;

  const type = typeof row.bk_type === "string" && row.bk_type ? row.bk_type : "RELATED_TO";

  return {
    id: bkId,
    type,
    sourceId,
    targetId,
    properties: {},
    createdAt: String(row.bk_created_at ?? new Date().toISOString()),
    updatedAt: String(row.bk_updated_at ?? new Date().toISOString()),
  };
}

async function queryVertices(adapter: ConnectorAdapter, database: string): Promise<Node[]> {
  const rows = await adapter.execute(database, "opencypher", "MATCH (n) WHERE n.bk_id IS NOT NULL RETURN n");
  return rows.flatMap((r) => {
    const node = rowToNode((r.n ?? r) as Record<string, unknown>);
    return node ? [node] : [];
  });
}

async function queryEdges(adapter: ConnectorAdapter, database: string): Promise<Edge[]> {
  const rows = await adapter.execute(
    database,
    "opencypher",
    `MATCH (a)-[r]->(b)
     WHERE r.bk_id IS NOT NULL AND a.bk_id IS NOT NULL AND b.bk_id IS NOT NULL
     RETURN r.bk_id AS bk_id, r.bk_type AS bk_type, r.bk_graph AS bk_graph,
            r.bk_created_at AS bk_created_at, r.bk_updated_at AS bk_updated_at,
            a.bk_id AS source_id, b.bk_id AS target_id`,
  );
  return rows.flatMap((r) => {
    const edge = rowToEdge(r);
    return edge ? [edge] : [];
  });
}

export async function synthesize(
  adapter: ConnectorAdapter,
  options: SynthesizeOptions,
  onProgress?: (msg: string) => void,
): Promise<SynthesizeResult> {
  const start = Date.now();
  const branch = options.branch ?? "main";

  if (options.projectFirst !== false) {
    for (const graph of options.graphs) {
      onProgress?.(`Projecting "${graph}"...`);
      await project(adapter, { backpackPath: options.backpackPath, graph, branch });
    }
  }

  const allNodes = new Map<string, Node>();
  const allEdges = new Map<string, Edge>();

  for (const graph of options.graphs) {
    const database = sanitizeDatabaseName(graph);
    if (!(await adapter.databaseExists(database))) {
      onProgress?.(`Skipping "${graph}" — not projected yet`);
      continue;
    }
    onProgress?.(`Reading "${graph}" from ${adapter.name}...`);
    for (const node of await queryVertices(adapter, database)) allNodes.set(node.id, node);
    for (const edge of await queryEdges(adapter, database)) allEdges.set(edge.id, edge);
  }

  const now = new Date().toISOString();
  const outputData: LearningGraphData = {
    metadata: {
      name: options.into,
      description: `Synthesized from: ${options.graphs.join(", ")}`,
      createdAt: now,
      updatedAt: now,
    },
    nodes: Array.from(allNodes.values()),
    edges: Array.from(allEdges.values()),
  };

  const backpack = await Backpack.fromActiveBackpack();
  if (await backpack.ontologyExists(options.into)) {
    if (options.reset) {
      onProgress?.(`Overwriting existing "${options.into}"...`);
      await backpack.deleteOntology(options.into);
    } else {
      throw new Error(`Graph "${options.into}" already exists. Pass reset=true to overwrite.`);
    }
  }

  onProgress?.(`Writing ${allNodes.size} nodes, ${allEdges.size} edges to "${options.into}"...`);
  await backpack.createOntologyFromData(options.into, outputData);

  return {
    outputGraph: options.into,
    nodeCount: allNodes.size,
    edgeCount: allEdges.size,
    sourceGraphs: options.graphs,
    durationMs: Date.now() - start,
    viewerUrl: `http://localhost:5173#${options.into}`,
  };
}
