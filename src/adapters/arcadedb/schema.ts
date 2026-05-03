import type { ArcadeDBClient } from "./client.js";

export function sanitizeIdent(s: string): string {
  const safe = s.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[0-9]/.test(safe) ? `_${safe}` : safe;
}

async function tryCommand(client: ArcadeDBClient, database: string, sql: string): Promise<void> {
  try {
    await client.command(database, sql);
  } catch {
  }
}

export class SchemaManager {
  private vertexTypes = new Map<string, Set<string>>();
  private edgeTypes = new Map<string, Set<string>>();

  private vSet(database: string): Set<string> {
    let s = this.vertexTypes.get(database);
    if (!s) { s = new Set(); this.vertexTypes.set(database, s); }
    return s;
  }

  private eSet(database: string): Set<string> {
    let s = this.edgeTypes.get(database);
    if (!s) { s = new Set(); this.edgeTypes.set(database, s); }
    return s;
  }

  async bootstrap(client: ArcadeDBClient, database: string): Promise<void> {
    // BackpackState: tracks projection ordinal per backpack+graph+branch
    await tryCommand(client, database, "CREATE DOCUMENT TYPE BackpackState");
    await tryCommand(client, database, "CREATE PROPERTY BackpackState.bk_backpack STRING");
    await tryCommand(client, database, "CREATE PROPERTY BackpackState.bk_graph STRING");
    await tryCommand(client, database, "CREATE PROPERTY BackpackState.bk_branch STRING");
    await tryCommand(client, database, "CREATE INDEX ON BackpackState (bk_backpack, bk_graph, bk_branch) UNIQUE");

    // BackpackIndex: maps bk_id → sanitized vertex type for edge creation lookups
    await tryCommand(client, database, "CREATE DOCUMENT TYPE BackpackIndex");
    await tryCommand(client, database, "CREATE PROPERTY BackpackIndex.bk_id STRING");
    await tryCommand(client, database, "CREATE PROPERTY BackpackIndex.bk_backpack STRING");
    await tryCommand(client, database, "CREATE PROPERTY BackpackIndex.node_type STRING");
    await tryCommand(client, database, "CREATE INDEX ON BackpackIndex (bk_id, bk_backpack) UNIQUE");
  }

  async ensureVertexType(client: ArcadeDBClient, database: string, type: string): Promise<void> {
    const name = sanitizeIdent(type);
    const set = this.vSet(database);
    if (set.has(name)) return;
    await tryCommand(client, database, `CREATE VERTEX TYPE ${name}`);
    await tryCommand(client, database, `CREATE PROPERTY ${name}.bk_id STRING`);
    await tryCommand(client, database, `CREATE INDEX ON ${name} (bk_id) UNIQUE`);
    set.add(name);
  }

  async ensureEdgeType(client: ArcadeDBClient, database: string, type: string): Promise<void> {
    const name = sanitizeIdent(type);
    const set = this.eSet(database);
    if (set.has(name)) return;
    await tryCommand(client, database, `CREATE EDGE TYPE ${name}`);
    set.add(name);
  }

  knownEdgeTypes(database: string): ReadonlySet<string> {
    return this.eSet(database);
  }
}
