#!/usr/bin/env node
import * as path from "node:path";
import { getActiveBackpack } from "backpack-ontology/connector";
import { createAdapter } from "../src/adapter-factory.js";
import { project } from "../src/projector.js";
import { runDaemon } from "../src/daemon.js";
import { sanitizeDatabaseName } from "../src/database-name.js";
import { synthesize } from "../src/synthesizer.js";
import { detectCrossGraphSignals } from "../src/cross-graph-signals.js";

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function str(v: string | boolean | undefined, fallback?: string): string | undefined {
  return typeof v === "string" ? v : fallback;
}

async function resolveBackpackPath(args: Record<string, string | boolean>): Promise<string> {
  if (args["backpack-path"]) return String(args["backpack-path"]);
  const entry = await getActiveBackpack();
  return entry.path;
}

function adapterArg(args: Record<string, string | boolean>) {
  return createAdapter({ adapter: str(args["adapter"]) ?? process.env.BACKPACK_ADAPTER ?? "arcadedb" });
}

// ─── project ─────────────────────────────────────────────────────────────────

async function cmdProject(args: Record<string, string | boolean>): Promise<void> {
  if (!args["graph"]) {
    process.stdout.write(`
Usage: backpack-connector project [options]

Required:
  --graph <name>           Learning graph name

Optional:
  --backpack-path <path>   Backpack directory (uses active backpack if omitted)
  --database <name>        Override database name
  --branch <branch>        Branch (default: main)
  --adapter <name>         Connector adapter (default: arcadedb, or BACKPACK_ADAPTER env)
  --reset                  Drop and recreate database before projecting

Tip — project multiple graphs into one database for cross-graph queries:
  backpack-connector project --graph graph-a --database shared
  backpack-connector project --graph graph-b --database shared
`);
    process.exit(1);
  }

  const adapter = adapterArg(args);
  const backpackPath = await resolveBackpackPath(args);
  const graphName = String(args["graph"]);

  process.stdout.write(`Projecting "${graphName}" (${adapter.name})...\n`);

  const result = await project(
    adapter,
    {
      backpackPath,
      graph: graphName,
      branch: str(args["branch"]),
      database: str(args["database"]),
      reset: args["reset"] === true,
    },
    (processed, nodeOps, edgeOps) => {
      process.stdout.write(`  ${processed} events (${nodeOps} node ops, ${edgeOps} edge ops)\r`);
    },
  );

  process.stdout.write(`\nDone: ${result.eventsProcessed} events in ${result.durationMs}ms\n`);
  process.stdout.write(`  Database: ${result.database}\n`);
  process.stdout.write(`  Node ops: ${result.nodeOps}\n`);
  process.stdout.write(`  Edge ops: ${result.edgeOps}\n`);
}

// ─── query ───────────────────────────────────────────────────────────────────

function renderTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(no results)\n";
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
  );
  const sep = "+-" + widths.map((w) => "-".repeat(w)).join("-+-") + "-+\n";
  const header = "| " + cols.map((c, i) => c.padEnd(widths[i])).join(" | ") + " |\n";
  const dataRows = rows
    .map((r) => "| " + cols.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join(" | ") + " |\n")
    .join("");
  return sep + header + sep + dataRows + sep;
}

async function cmdQuery(args: Record<string, string | boolean>): Promise<void> {
  const database = args["database"]
    ? String(args["database"])
    : args["graph"]
    ? sanitizeDatabaseName(String(args["graph"]))
    : null;

  const queryText = str(args["cypher"]) ?? str(args["sql"]);
  const language = args["sql"] ? "sql" : "opencypher";

  if (!database || !queryText) {
    process.stdout.write(`
Usage: backpack-connector query [options]

Required (one of):
  --database <name>    Database name
  --graph <name>       Graph name (derives database name)

Required (one of):
  --cypher <query>     Cypher (OpenCypher) query
  --sql <query>        SQL query

Optional:
  --adapter <name>     Adapter (default: arcadedb)
  --table              Output as ASCII table (default: JSON)

Examples:
  backpack-connector query --graph my-graph \\
    --cypher "MATCH (p:Platform)-[r]->(a:API) RETURN p.name, type(r), a.name"

  backpack-connector query --database shared \\
    --cypher "MATCH (n) WHERE n.bk_graph IN ['graph-a','graph-b'] RETURN n.name, n.bk_graph ORDER BY n.name"

  backpack-connector query --graph my-graph \\
    --sql "SELECT name, type FROM schema:types WHERE type = 'vertex'"
`);
    process.exit(1);
  }

  const adapter = adapterArg(args);
  const rows = await adapter.execute(database, language, queryText);

  if (args["table"]) {
    process.stdout.write(renderTable(rows as Record<string, unknown>[]));
  } else {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  }
}

// ─── schema ──────────────────────────────────────────────────────────────────

async function cmdSchema(args: Record<string, string | boolean>): Promise<void> {
  const database = args["database"]
    ? String(args["database"])
    : args["graph"]
    ? sanitizeDatabaseName(String(args["graph"]))
    : null;

  if (!database) {
    process.stdout.write("Usage: backpack-connector schema --graph <name> | --database <name> [--adapter <name>]\n");
    process.exit(1);
  }

  const adapter = adapterArg(args);
  const schema = await adapter.getSchema(database);
  process.stdout.write(JSON.stringify(schema, null, 2) + "\n");
}

// ─── daemon ──────────────────────────────────────────────────────────────────

async function cmdDaemon(args: Record<string, string | boolean>): Promise<void> {
  if (!args["graph"]) {
    process.stdout.write(`
Usage: backpack-connector daemon [options]

Required:
  --graph <name>          Graph to watch (repeat for multiple graphs)
  [multiple graphs not yet supported — pass comma-separated: --graph graph-a,graph-b]

Optional:
  --backpack-path <path>  Backpack directory (uses active backpack if omitted)
  --database <name>       Override database name
  --adapter <name>        Adapter (default: arcadedb)
  --poll <ms>             Poll interval in milliseconds (default: 1000)
`);
    process.exit(1);
  }

  const adapter = adapterArg(args);
  const backpackPath = await resolveBackpackPath(args);
  const graphs = String(args["graph"]).split(",").map((g) => g.trim());
  const pollMs = args["poll"] ? parseInt(String(args["poll"]), 10) : 1000;

  process.stderr.write(
    `Daemon watching ${graphs.join(", ")} (${adapter.name}, polling every ${pollMs}ms)\n`,
  );

  await runDaemon({
    adapter,
    targets: graphs.map((graph) => ({
      backpackPath,
      graph,
      database: str(args["database"]),
    })),
    pollMs,
    onSync: (graph, count) => process.stderr.write(`Synced ${count} events for "${graph}"\n`),
    onError: (graph, err) => process.stderr.write(`Error syncing "${graph}": ${err.message}\n`),
  });
}

// ─── synthesize ──────────────────────────────────────────────────────────────

async function cmdSynthesize(args: Record<string, string | boolean>): Promise<void> {
  const graphsArg = str(args["graphs"]);
  const into = str(args["into"]);

  if (!graphsArg || !into) {
    process.stdout.write(`
Usage: backpack-connector synthesize [options]

Required:
  --graphs <a,b,c>         Comma-separated list of learning graph names to combine
  --into <name>            Output graph name

Optional:
  --backpack-path <path>   Backpack directory (uses active backpack if omitted)
  --branch <branch>        Source branch (default: main)
  --adapter <name>         Adapter (default: arcadedb)
  --reset                  Overwrite output graph if it exists
  --no-project             Skip projecting source graphs (use existing projections)

Example:
  backpack-connector synthesize \\
    --graphs "teams-bot,ms-graph-research,azure-speech" \\
    --into teams-bot-unified

  # Then view at http://localhost:5173#teams-bot-unified
  # Run 'backpack-connector signals --graphs teams-bot,ms-graph-research,azure-speech'
  # to see which entities appear in multiple graphs
`);
    process.exit(1);
  }

  const graphs = graphsArg.split(",").map((g) => g.trim()).filter(Boolean);
  if (graphs.length < 2) {
    process.stderr.write("Error: provide at least 2 graphs to synthesize.\n");
    process.exit(1);
  }

  const adapter = adapterArg(args);
  const backpackPath = await resolveBackpackPath(args);

  process.stdout.write(`Synthesizing ${graphs.join(", ")} → "${into}"...\n`);

  const result = await synthesize(
    adapter,
    {
      backpackPath,
      graphs,
      into,
      branch: str(args["branch"]),
      reset: args["reset"] === true,
      projectFirst: args["no-project"] !== true,
    },
    (msg) => process.stdout.write(`  ${msg}\n`),
  );

  process.stdout.write(`\nDone in ${result.durationMs}ms\n`);
  process.stdout.write(`  Output:  ${result.outputGraph}\n`);
  process.stdout.write(`  Nodes:   ${result.nodeCount}\n`);
  process.stdout.write(`  Edges:   ${result.edgeCount}\n`);
  process.stdout.write(`  Viewer:  ${result.viewerUrl}\n`);
  process.stdout.write(`\nRun 'backpack-connector signals --graphs ${graphs.join(",")}' to see cross-graph duplicates.\n`);
}

// ─── signals ─────────────────────────────────────────────────────────────────

async function cmdSignals(args: Record<string, string | boolean>): Promise<void> {
  const graphsArg = str(args["graphs"]);
  const graphs = graphsArg ? graphsArg.split(",").map((g) => g.trim()).filter(Boolean) : undefined;
  const threshold = args["threshold"] ? parseInt(String(args["threshold"]), 10) : 2;

  if (!graphs) {
    process.stdout.write("Auto-detecting projected graphs...\n");
  }

  const adapter = adapterArg(args);
  const report = await detectCrossGraphSignals(adapter, { graphs, threshold });

  process.stdout.write(`\nAnalyzed: ${report.analyzedGraphs.join(", ")}\n`);
  process.stdout.write(`${report.summary}\n\n`);

  if (report.duplicateEntities.length > 0) {
    process.stdout.write(`Top cross-graph duplicates:\n`);
    const top = report.duplicateEntities.slice(0, 10);
    for (const entity of top) {
      const graphNames = [...new Set(entity.appearances.map((a) => a.graph))];
      process.stdout.write(
        `  "${entity.label}" (${entity.type}) — appears in ${graphNames.length} graphs: ${graphNames.join(", ")}\n`,
      );
    }
    if (report.duplicateEntities.length > 10) {
      process.stdout.write(`  ... and ${report.duplicateEntities.length - 10} more\n`);
    }
    process.stdout.write(`\nFull report (JSON):\n`);
    if (args["json"]) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(`  Run with --json for the full machine-readable report\n`);
    }
  }
}

// ─── mcp-config ──────────────────────────────────────────────────────────────

async function cmdMcpConfig(args: Record<string, string | boolean>): Promise<void> {
  const serverName = str(args["name"]) ?? "backpack";
  const adapterName = str(args["adapter"]) ?? process.env.BACKPACK_ADAPTER ?? "arcadedb";

  const mcpServerPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "mcp-server.js",
  );

  const env: Record<string, string> = { BACKPACK_ADAPTER: adapterName };
  if (adapterName === "arcadedb") {
    env.ARCADEDB_URL = str(args["url"]) ?? "http://localhost:2480";
    env.ARCADEDB_USERNAME = str(args["username"]) ?? "root";
    env.ARCADEDB_PASSWORD = str(args["password"]) ?? "arcadedb";
  }

  const config = {
    mcpServers: {
      [serverName]: { command: "node", args: [mcpServerPath], env },
    },
  };

  process.stdout.write(`
# Add to ~/.claude/settings.json (merge the mcpServers block):
# OR ~/Library/Application Support/Claude/claude_desktop_config.json

${JSON.stringify(config, null, 2)}

# This server includes ALL backpack-ontology tools AND connector_project/query/schema/status.
# Remove any separate backpack-ontology MCP entry once this is wired up.
`);
}

// ─── router ──────────────────────────────────────────────────────────────────

function globalUsage(): void {
  process.stdout.write(`
Usage: backpack-connector <command> [options]

Commands:
  project     Project a learning graph into the connected graph database
  synthesize  Combine multiple graphs into a unified view via ArcadeDB UNION
  signals     Detect entities appearing in multiple graphs (cross-graph duplicates)
  query       Run Cypher or SQL against a projected graph
  schema      Show schema for a projected graph
  daemon      Watch for new events and project them continuously
  mcp-config  Print Claude MCP server configuration (unified backpack + connector)

Run backpack-connector <command> with no args for command-specific help.
`);
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  switch (subcommand) {
    case "project":    return cmdProject(args);
    case "query":      return cmdQuery(args);
    case "schema":     return cmdSchema(args);
    case "daemon":     return cmdDaemon(args);
    case "synthesize": return cmdSynthesize(args);
    case "signals":    return cmdSignals(args);
    case "mcp-config": return cmdMcpConfig(args);
    default:
      globalUsage();
      if (subcommand) process.exit(1);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
