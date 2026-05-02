import * as fs from "node:fs/promises";
import { Backpack, EventSourcedBackend, SignalStore } from "backpack-ontology";
import type { Signal, SignalSeverity, GlobalSignalConfig } from "backpack-ontology/connector";
import { signalConfigFile } from "backpack-ontology/connector";
import type { ConnectorAdapter } from "./adapter.js";
import { sanitizeDatabaseName } from "./database-name.js";

export interface ConnectorSignalResult {
  detected: number;
  signals: Signal[];
}

function makeId(kind: string, ...parts: string[]): string {
  return `${kind}:${[...parts].sort().join(",")}`;
}

function interpolate(template: string, row: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(row[k] ?? ""));
}

export async function loadGlobalSignalConfig(): Promise<GlobalSignalConfig> {
  try {
    const raw = await fs.readFile(signalConfigFile(), "utf8");
    return JSON.parse(raw) as GlobalSignalConfig;
  } catch {
    return {};
  }
}

function isEnabled(cfg: GlobalSignalConfig, kind: string): boolean {
  return cfg.detectors?.[kind]?.enabled !== false;
}

function paramsFor(cfg: GlobalSignalConfig, kind: string): Record<string, unknown> {
  return cfg.detectors?.[kind]?.params ?? {};
}

async function detectTypeDrift(
  adapter: ConnectorAdapter,
  databases: string[],
  cfg: GlobalSignalConfig,
): Promise<Signal[]> {
  if (!isEnabled(cfg, "connector.type_drift")) return [];

  const allNodes: Array<{ name: string; type: string; graph: string; bkId: string }> = [];

  for (const db of databases) {
    try {
      const rows = await adapter.execute(db, "opencypher",
        "MATCH (n) WHERE n.bk_id IS NOT NULL AND n.name IS NOT NULL RETURN n.bk_id AS id, n.name AS name, n.bk_type AS type, n.bk_graph AS graph"
      );
      for (const r of rows) {
        if (r.name && r.type && r.graph) {
          allNodes.push({ name: String(r.name), type: String(r.type), graph: String(r.graph), bkId: String(r.id) });
        }
      }
    } catch { continue; }
  }

  const byName = new Map<string, typeof allNodes>();
  for (const n of allNodes) {
    const key = n.name.toLowerCase().trim();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(n);
  }

  const signals: Signal[] = [];
  for (const [, nodes] of byName) {
    const types = [...new Set(nodes.map((n) => n.type))];
    if (types.length < 2) continue;
    const graphs = [...new Set(nodes.map((n) => n.graph))];
    signals.push({
      id: makeId("connector.type_drift", ...nodes.map((n) => n.bkId)),
      kind: "connector.type_drift",
      category: "structural",
      severity: "medium" as SignalSeverity,
      title: `"${nodes[0].name}" typed differently across graphs`,
      description: `"${nodes[0].name}" appears as ${types.map((t) => `"${t}"`).join(" and ")} across ${graphs.join(", ")}. Inconsistent typing makes cross-graph traversal unreliable and is a primary target for entity resolution.`,
      evidenceNodeIds: nodes.map((n) => n.bkId),
      evidenceDocIds: [],
      graphNames: graphs,
      score: types.length * graphs.length,
      tags: ["connector", "type-drift"],
    });
  }

  return signals.sort((a, b) => b.score - a.score).slice(0, 20);
}

async function detectCentralityHub(
  adapter: ConnectorAdapter,
  databases: string[],
  cfg: GlobalSignalConfig,
): Promise<Signal[]> {
  if (!isEnabled(cfg, "connector.centrality_hub")) return [];
  const stdThreshold = (paramsFor(cfg, "connector.centrality_hub").stdThreshold as number) ?? 2.5;

  const signals: Signal[] = [];

  for (const db of databases) {
    try {
      // Get degrees via explicit MATCH — size((n)--()) is not supported in ArcadeDB Cypher
      // Query ALL connected nodes (include low-degree for accurate baseline statistics)
      const rows = await adapter.execute(db, "opencypher",
        `MATCH (n)-[r]-()
         WHERE n.bk_id IS NOT NULL
         WITH n, count(r) AS degree
         RETURN n.bk_id AS id, n.name AS name, n.bk_type AS bk_type,
                n.bk_graph AS bk_graph, degree
         ORDER BY degree DESC`
      );

      if (rows.length < 5) continue;

      const degrees = rows.map((r) => Number(r.degree ?? 0));
      const avg = degrees.reduce((a, b) => a + b, 0) / degrees.length;
      const variance = degrees.reduce((a, b) => a + (b - avg) ** 2, 0) / degrees.length;
      const std = Math.sqrt(variance);
      const threshold = avg + stdThreshold * std;

      for (const r of rows) {
        const degree = Number(r.degree ?? 0);
        if (degree <= threshold || degree <= 3) continue;
        signals.push({
          id: makeId("connector.centrality_hub", String(r.id ?? ""), db),
          kind: "connector.centrality_hub",
          category: "structural",
          severity: "medium" as SignalSeverity,
          title: `"${r.name}" is a hub with ${degree} connections (avg: ${avg.toFixed(1)})`,
          description: `"${r.name}" (${r.bk_type}) connects to ${degree} other entities — ${(degree / (avg || 1)).toFixed(1)}× the graph average of ${avg.toFixed(1)}. Hub nodes often represent over-generalized concepts or aggregation points worth decomposing into more specific entities.`,
          evidenceNodeIds: [String(r.id ?? "")],
          evidenceDocIds: [],
          graphNames: [String(r.bk_graph ?? db)],
          score: degree,
          tags: ["connector", "centrality"],
        });
      }
    } catch { continue; }
  }

  return signals;
}

async function detectCommunityBridge(
  adapter: ConnectorAdapter,
  databases: string[],
  cfg: GlobalSignalConfig,
): Promise<Signal[]> {
  if (!isEnabled(cfg, "connector.community_bridge")) return [];

  const signals: Signal[] = [];

  for (const db of databases) {
    try {
      const rows = await adapter.execute(db, "opencypher",
        `MATCH (n)-[r1]->(a), (n)-[r2]->(b)
         WHERE n.bk_id IS NOT NULL AND a.bk_graph IS NOT NULL AND b.bk_graph IS NOT NULL
         AND a.bk_graph <> b.bk_graph
         WITH n, count(DISTINCT a.bk_graph) AS graph_connections,
              collect(DISTINCT a.bk_graph)[0..3] AS connected_graphs
         WHERE graph_connections >= 2
         RETURN n.bk_id AS id, n.name AS name, n.bk_type AS type,
                n.bk_graph AS graph, graph_connections, connected_graphs
         ORDER BY graph_connections DESC LIMIT 5`
      );

      for (const r of rows) {
        const connectedGraphs = Array.isArray(r.connected_graphs) ? r.connected_graphs : [];
        signals.push({
          id: makeId("connector.community_bridge", String(r.id ?? ""), db),
          kind: "connector.community_bridge",
          category: "structural",
          severity: "low" as SignalSeverity,
          title: `"${r.name}" bridges ${r.graph_connections} source graphs`,
          description: `"${r.name}" (${r.type}) connects to entities from ${connectedGraphs.join(", ")} and more. Cross-graph bridge nodes are high-value candidates for canonicalization — they represent concepts that appear in multiple knowledge domains.`,
          evidenceNodeIds: [String(r.id ?? "")],
          evidenceDocIds: [],
          graphNames: [String(r.graph ?? db), ...connectedGraphs.map(String)],
          score: Number(r.graph_connections ?? 0),
          tags: ["connector", "bridge"],
        });
      }
    } catch { continue; }
  }

  return signals;
}

async function detectCrossGraphStructural(
  adapter: ConnectorAdapter,
  databases: string[],
  cfg: GlobalSignalConfig,
): Promise<Signal[]> {
  if (!isEnabled(cfg, "connector.cross_graph_structural")) return [];

  const minGraphs = (paramsFor(cfg, "connector.cross_graph_structural").minGraphs as number) ?? 2;
  const allNodes: Array<{ name: string; type: string; graph: string; bkId: string }> = [];

  for (const db of databases) {
    try {
      const rows = await adapter.execute(db, "opencypher",
        "MATCH (n) WHERE n.bk_id IS NOT NULL AND n.name IS NOT NULL RETURN n.bk_id AS id, n.name AS name, n.bk_type AS type, n.bk_graph AS graph"
      );
      for (const r of rows) {
        if (r.name && r.graph) allNodes.push({ name: String(r.name), type: String(r.type ?? ""), graph: String(r.graph), bkId: String(r.id) });
      }
    } catch { continue; }
  }

  const byLabel = new Map<string, typeof allNodes>();
  for (const n of allNodes) {
    const key = n.name.toLowerCase().trim();
    if (!byLabel.has(key)) byLabel.set(key, []);
    byLabel.get(key)!.push(n);
  }

  const signals: Signal[] = [];
  for (const [, nodes] of byLabel) {
    const graphs = [...new Set(nodes.map((n) => n.graph))];
    if (graphs.length < minGraphs) continue;

    const types = [...new Set(nodes.map((n) => n.type))];
    const hasDrift = types.length > 1;
    const confidence = Math.min(1.0, 0.5 + graphs.length * 0.1 + (hasDrift ? 0 : 0.2));

    signals.push({
      id: makeId("connector.cross_graph_structural", ...nodes.map((n) => n.bkId)),
      kind: "connector.cross_graph_structural",
      category: "structural",
      severity: graphs.length >= 3 ? "high" : "medium",
      title: `"${nodes[0].name}" appears in ${graphs.length} graphs (confidence: ${Math.round(confidence * 100)}%)`,
      description: `"${nodes[0].name}" exists in ${graphs.join(", ")}${hasDrift ? ` with inconsistent types (${types.join(", ")})` : ""}. Confidence this represents the same real-world entity: ${Math.round(confidence * 100)}%. Entity resolution would merge these into one canonical node.`,
      evidenceNodeIds: nodes.map((n) => n.bkId),
      evidenceDocIds: [],
      graphNames: graphs,
      score: confidence * 10 * graphs.length,
      tags: ["connector", "resolution-candidate"],
    });
  }

  return signals.sort((a, b) => b.score - a.score).slice(0, 25);
}

async function runUserDefinedDetectors(
  adapter: ConnectorAdapter,
  cfg: GlobalSignalConfig,
): Promise<Signal[]> {
  const signals: Signal[] = [];

  for (const [kind, detectorCfg] of Object.entries(cfg.detectors ?? {})) {
    if (detectorCfg.enabled === false) continue;
    const query = detectorCfg.params?.query as UserDefinedQuery | undefined;
    if (!query || !query.command || !query.database || !query.signalTemplate) continue;

    try {
      const rows = await adapter.execute(query.database, query.type ?? "opencypher", query.command);
      const tmpl = query.signalTemplate;

      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const title = tmpl.titleField ? String(r[tmpl.titleField] ?? "") : interpolate(tmpl.titleTemplate ?? kind, r);
        const description = interpolate(tmpl.descriptionTemplate ?? "", r);
        const evidenceId = tmpl.evidenceField ? String(r[tmpl.evidenceField] ?? "") : "";
        const score = tmpl.scoreField ? Number(r[tmpl.scoreField] ?? 0) : 0.5;

        signals.push({
          id: makeId(tmpl.kind ?? kind, evidenceId, query.database),
          kind: tmpl.kind ?? kind,
          category: "structural",
          severity: (tmpl.severity as SignalSeverity) ?? "medium",
          title,
          description,
          evidenceNodeIds: evidenceId ? [evidenceId] : [],
          evidenceDocIds: [],
          graphNames: [query.database.replace(/_/g, "-")],
          score,
          tags: ["connector", "user-defined"],
        });
      }
    } catch (e) {
      process.stderr.write(`Warning: user-defined detector "${kind}" failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  return signals;
}

export interface UserDefinedQuery {
  type?: "opencypher" | "sql";
  database: string;
  command: string;
  signalTemplate: {
    kind?: string;
    severity?: string;
    titleField?: string;
    titleTemplate?: string;
    descriptionTemplate: string;
    evidenceField?: string;
    scoreField?: string;
  };
}

export async function runConnectorSignals(
  adapter: ConnectorAdapter,
  backpackPath: string,
): Promise<ConnectorSignalResult> {
  const cfg = await loadGlobalSignalConfig();

  const backend = new EventSourcedBackend(undefined, { graphsDirOverride: backpackPath });
  const backpack = new Backpack(backend);
  await backpack.initialize();
  const graphs = await backpack.listOntologies();
  const databases = (
    await Promise.all(
      graphs.map(async (g) => {
        const db = sanitizeDatabaseName(g.name);
        return (await adapter.databaseExists(db)) ? db : null;
      })
    )
  ).filter((db): db is string => db !== null);

  if (databases.length === 0) {
    return { detected: 0, signals: [] };
  }

  const results = await Promise.allSettled([
    detectTypeDrift(adapter, databases, cfg),
    detectCentralityHub(adapter, databases, cfg),
    detectCommunityBridge(adapter, databases, cfg),
    detectCrossGraphStructural(adapter, databases, cfg),
    runUserDefinedDetectors(adapter, cfg),
  ]);

  const all = results.flatMap((r) => {
    if (r.status === "fulfilled") return r.value;
    process.stderr.write(`Warning: connector signal detector failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}\n`);
    return [];
  });

  if (all.length > 0) {
    const store = new SignalStore(backpackPath);
    await store.mergeExternalSignals(all);
  }

  return { detected: all.length, signals: all };
}
