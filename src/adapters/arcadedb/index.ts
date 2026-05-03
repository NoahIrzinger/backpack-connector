import type { GraphEvent, NodeUpdateEvent, NodeRemoveEvent } from "backpack-ontology/connector";
import type { ConnectorAdapter, ConnectorSchema } from "../../adapter.js";
import { ArcadeDBClient, type ArcadeDBConfig } from "./client.js";
import { SchemaManager, sanitizeIdent } from "./schema.js";
import {
  translateEvent,
  translateNodeUpdate,
  translateNodeRemove,
  translateEdgeAdd,
  translateEdgeRemove,
} from "./translate.js";

export { ArcadeDBClient, type ArcadeDBConfig };

export class ArcadeDBAdapter implements ConnectorAdapter {
  readonly name = "ArcadeDB";
  readonly description = "ArcadeDB multi-model graph database — Cypher, SQL, vector, full-text, time-series";
  readonly queryLanguages = ["opencypher", "sql", "gremlin"] as const;

  private schema = new SchemaManager();
  // Per-database node type cache: Map<database+backpack, Map<bkId, sanitizedTypeSafe>>
  private nodeTypeCache = new Map<string, Map<string, string>>();

  constructor(private client: ArcadeDBClient) {}

  async databaseExists(database: string): Promise<boolean> {
    return this.client.databaseExists(database);
  }

  async createDatabase(database: string): Promise<void> {
    return this.client.createDatabase(database);
  }

  async dropDatabase(database: string): Promise<void> {
    this.nodeTypeCache.clear();
    return this.client.dropDatabase(database);
  }

  async bootstrapSchema(database: string): Promise<void> {
    await this.schema.bootstrap(this.client, database);
    await this.warmNodeTypeCache(database);
  }

  async resetGraph(database: string, backpackName: string, graph: string, branch: string): Promise<void> {
    // Delete only this graph's nodes from the shared database — cascades edges
    const esc = (s: string) => s.replace(/'/g, "\\'");
    await this.client.command(
      database,
      `MATCH (n) WHERE n.bk_backpack = :backpack AND n.bk_graph = :graph AND n.bk_branch = :branch DETACH DELETE n`,
      { backpack: backpackName, graph, branch },
    ).catch(() =>
      this.client.execute(database, "opencypher",
        `MATCH (n) WHERE n.bk_backpack = '${esc(backpackName)}' AND n.bk_graph = '${esc(graph)}' AND n.bk_branch = '${esc(branch)}' DETACH DELETE n`
      )
    );
    // Reset ordinal tracking for this graph
    await this.client.command(
      database,
      "DELETE FROM BackpackState WHERE bk_backpack = :backpack AND bk_graph = :graph AND bk_branch = :branch",
      { backpack: backpackName, graph, branch },
    ).catch(() => {});
    // Clear this graph from BackpackIndex
    await this.client.command(
      database,
      "DELETE FROM BackpackIndex WHERE bk_backpack = :backpack",
      { backpack: backpackName },
    ).catch(() => {});
    // Invalidate cache
    this.nodeTypeCache.delete(`${database}:${backpackName}`);
  }

  async getLastOrdinal(database: string, backpackName: string, graph: string, branch: string): Promise<number> {
    try {
      const rows = await this.client.query(
        database,
        "SELECT last_ordinal FROM BackpackState WHERE bk_backpack = :backpack AND bk_graph = :graph AND bk_branch = :branch",
        { backpack: backpackName, graph, branch },
      );
      const val = rows[0]?.last_ordinal;
      return typeof val === "number" ? val : 0;
    } catch {
      return 0;
    }
  }

  async setLastOrdinal(database: string, backpackName: string, graph: string, branch: string, ordinal: number): Promise<void> {
    await this.client.command(
      database,
      "UPDATE BackpackState SET last_ordinal = :ordinal, projected_at = :projected_at, bk_backpack = :backpack, bk_graph = :graph, bk_branch = :branch UPSERT WHERE bk_backpack = :backpack AND bk_graph = :graph AND bk_branch = :branch",
      { ordinal, projected_at: new Date().toISOString(), backpack: backpackName, graph, branch },
    );
  }

  async applyEvent(event: GraphEvent, database: string, backpackName: string, graph: string, branch: string): Promise<void> {
    const result = translateEvent(event, backpackName, graph, branch);
    if (!result) return;

    if (result.kind === "cmds") {
      if (result.nodeType) {
        await this.schema.ensureVertexType(this.client, database, result.nodeType);
      }
      for (const cmd of result.cmds) {
        await this.client.command(database, cmd.sql, cmd.params);
      }
      if (event.op === "node.add") {
        this.cacheNodeType(database, backpackName, event.node.id, sanitizeIdent(event.node.type));
      }
      return;
    }

    if (result.kind === "needs-node-lookup") {
      const typeSafe = await this.resolveNodeType(database, backpackName, result.bkId);
      if (!typeSafe) {
        process.stderr.write(`Warning: ${event.op} skipped — type unknown for ${result.bkId}\n`);
        return;
      }
      if (event.op === "node.update") {
        const cmd = translateNodeUpdate(event as NodeUpdateEvent, typeSafe);
        await this.client.command(database, cmd.sql, cmd.params);
      } else if (event.op === "node.remove") {
        const cmds = translateNodeRemove(event as NodeRemoveEvent, typeSafe);
        for (const cmd of cmds) await this.client.command(database, cmd.sql, cmd.params);
        this.nodeTypeCache.get(`${database}:${backpackName}`)?.delete(result.bkId);
      }
      return;
    }

    if (result.kind === "needs-edge-lookup") {
      const { edge } = result;
      await this.schema.ensureEdgeType(this.client, database, edge.type);
      const sourceType = await this.resolveNodeType(database, backpackName, edge.sourceId);
      const targetType = await this.resolveNodeType(database, backpackName, edge.targetId);
      if (!sourceType || !targetType) {
        process.stderr.write(`Warning: edge.add skipped — endpoint type unknown (${edge.sourceId} → ${edge.targetId})\n`);
        return;
      }
      const cmds = translateEdgeAdd(edge, sourceType, targetType, backpackName, graph, branch);
      for (const cmd of cmds) await this.client.command(database, cmd.sql, cmd.params);
      return;
    }

    if (result.kind === "needs-edge-type-lookup") {
      const edgeTypes = Array.from(this.schema.knownEdgeTypes(database));
      for (const typeSafe of edgeTypes) {
        const rows = await this.client.query(database, `SELECT bk_id FROM ${typeSafe} WHERE bk_id = :bk_id`, { bk_id: result.edgeId });
        if (rows.length > 0) {
          const cmd = translateEdgeRemove({ v: 1, ts: new Date().toISOString(), op: "edge.remove", id: result.edgeId }, typeSafe);
          await this.client.command(database, cmd.sql, cmd.params);
          return;
        }
      }
      process.stderr.write(`Warning: edge.remove skipped — edge ${result.edgeId} not found\n`);
    }
  }

  async execute(database: string, language: string, query: string): Promise<Record<string, unknown>[]> {
    return this.client.execute(database, language, query);
  }

  async getSchema(database: string): Promise<ConnectorSchema> {
    const types = await this.client.query(
      database,
      "SELECT name, type, properties FROM schema:types WHERE type IN ['vertex', 'edge']",
    );
    const vertexTypes = types.filter((t) => t.type === "vertex").map((t) => ({
      name: String(t.name),
      properties: Object.keys((t.properties as Record<string, unknown>) ?? {}).filter((p) => !p.startsWith("@")),
    }));
    const edgeTypes = types.filter((t) => t.type === "edge").map((t) => ({ name: String(t.name) }));
    const stateRows = await this.client.query(database, "SELECT bk_backpack, bk_graph, bk_branch, last_ordinal, projected_at FROM BackpackState").catch(() => [] as Record<string, unknown>[]);
    const state = stateRows[0];
    return {
      database,
      projection: state ? {
        graph: String(state.bk_graph ?? ""),
        branch: String(state.bk_branch ?? ""),
        lastOrdinal: Number(state.last_ordinal ?? 0),
        projectedAt: String(state.projected_at ?? ""),
      } : null,
      vertexTypes,
      edgeTypes,
    };
  }

  private cacheNodeType(database: string, backpackName: string, bkId: string, typeSafe: string): void {
    const key = `${database}:${backpackName}`;
    let dbCache = this.nodeTypeCache.get(key);
    if (!dbCache) { dbCache = new Map(); this.nodeTypeCache.set(key, dbCache); }
    dbCache.set(bkId, typeSafe);
  }

  private async resolveNodeType(database: string, backpackName: string, bkId: string): Promise<string | null> {
    const key = `${database}:${backpackName}`;
    const cached = this.nodeTypeCache.get(key)?.get(bkId);
    if (cached) return cached;
    try {
      const rows = await this.client.query(
        database,
        "SELECT node_type FROM BackpackIndex WHERE bk_id = :bk_id AND bk_backpack = :backpack",
        { bk_id: bkId, backpack: backpackName },
      );
      const raw = rows[0]?.node_type;
      if (typeof raw !== "string") return null;
      const typeSafe = sanitizeIdent(raw);
      this.cacheNodeType(database, backpackName, bkId, typeSafe);
      return typeSafe;
    } catch {
      return null;
    }
  }

  private async warmNodeTypeCache(database: string): Promise<void> {
    try {
      const rows = await this.client.query(database, "SELECT bk_id, node_type, bk_backpack FROM BackpackIndex LIMIT 100000");
      for (const row of rows) {
        if (typeof row.bk_id === "string" && typeof row.node_type === "string" && typeof row.bk_backpack === "string") {
          this.cacheNodeType(database, row.bk_backpack, row.bk_id, row.node_type);
        }
      }
    } catch {
    }
  }
}
