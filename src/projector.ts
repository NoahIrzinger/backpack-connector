import type { ConnectorAdapter } from "./adapter.js";
import { streamEvents, eventsFilePath, eventsFileExists } from "./event-reader.js";
import { DEFAULT_DATABASE, backpackNameFromPath } from "./database-name.js";

export interface ProjectOptions {
  backpackPath: string;
  graph: string;
  branch?: string;
  database?: string;   // override; default: "backpack"
  reset?: boolean;     // reset this graph's projection (does NOT drop the shared database)
}

export interface ProjectResult {
  database: string;
  graph: string;
  branch: string;
  backpackName: string;
  eventsProcessed: number;
  nodeOps: number;
  edgeOps: number;
  durationMs: number;
}

const STATE_FLUSH_INTERVAL = 50;

export async function project(
  adapter: ConnectorAdapter,
  options: ProjectOptions,
  onProgress?: (processed: number, nodeOps: number, edgeOps: number) => void,
): Promise<ProjectResult> {
  const branch = options.branch ?? "main";
  const database = options.database ?? DEFAULT_DATABASE;
  const backpackName = backpackNameFromPath(options.backpackPath);
  const filePath = eventsFilePath(options.backpackPath, options.graph, branch);

  if (!(await eventsFileExists(options.backpackPath, options.graph, branch))) {
    throw new Error(
      `Events file not found: ${filePath}\n` +
      `Check that --backpack-path points to a valid backpack directory and --graph matches a graph name.`,
    );
  }

  const exists = await adapter.databaseExists(database);
  if (!exists) {
    await adapter.createDatabase(database);
  }

  await adapter.bootstrapSchema(database);

  if (options.reset) {
    // In a shared database, only delete this specific graph's nodes (cascades edges).
    // Never drop the entire database — other graphs live here too.
    await adapter.resetGraph(database, backpackName, options.graph, branch);
  }

  const fromOrdinal = options.reset ? 0 : await adapter.getLastOrdinal(database, backpackName, options.graph, branch);

  const start = Date.now();
  let eventsProcessed = 0;
  let nodeOps = 0;
  let edgeOps = 0;
  let lastOrdinal = fromOrdinal;

  for await (const { event, ordinal } of streamEvents(filePath, fromOrdinal)) {
    await adapter.applyEvent(event, database, backpackName, options.graph, branch);

    const op = event.op;
    if (op.startsWith("node.")) nodeOps++;
    else if (op.startsWith("edge.")) edgeOps++;

    eventsProcessed++;
    lastOrdinal = ordinal;

    if (eventsProcessed % STATE_FLUSH_INTERVAL === 0) {
      await adapter.setLastOrdinal(database, backpackName, options.graph, branch, lastOrdinal);
      onProgress?.(eventsProcessed, nodeOps, edgeOps);
    }
  }

  await adapter.setLastOrdinal(database, backpackName, options.graph, branch, lastOrdinal);

  return { database, graph: options.graph, branch, backpackName, eventsProcessed, nodeOps, edgeOps, durationMs: Date.now() - start };
}
