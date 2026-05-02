import type { McpServer } from "backpack-ontology/connector";
import { z } from "zod";
import { getActiveBackpack } from "backpack-ontology/connector";
import type { ConnectorAdapter } from "../adapter.js";
import { project } from "../projector.js";
import { sanitizeDatabaseName } from "../database-name.js";
import { synthesize } from "../synthesizer.js";
import { detectCrossGraphSignals } from "../cross-graph-signals.js";
import { runConnectorSignals } from "../connector-signals.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

async function resolveBackpackPath(provided?: string): Promise<string> {
  if (provided) return provided;
  const entry = await getActiveBackpack();
  return entry.path;
}

export function registerConnectorTools(server: McpServer, adapter: ConnectorAdapter): void {
  server.registerTool(
    "connector_project",
    {
      title: "Project Graph into " + adapter.name,
      description:
        `Project a Backpack learning graph into ${adapter.name} for graph traversal queries. ` +
        `Uses the active backpack if backpackPath is not specified. ` +
        `Projection is incremental — only new events since the last run are processed. ` +
        `Pass reset=true to rebuild from scratch. ` +
        `After projection, use connector_query to run ${adapter.queryLanguages.join("/")} queries.`,
      inputSchema: {
        graph: z.string().describe("Learning graph name to project"),
        backpackPath: z.string().optional().describe("Backpack directory path (uses active backpack if omitted)"),
        database: z.string().optional().describe("Override database name (default: graph name with hyphens → underscores)"),
        branch: z.string().optional().describe("Branch to project (default: main)"),
        reset: z.boolean().optional().describe("Drop and recreate the database before projecting (default: false)"),
      },
    },
    async ({ graph, backpackPath, database, branch, reset }) => {
      try {
        const resolvedPath = await resolveBackpackPath(backpackPath);
        const result = await project(adapter, { backpackPath: resolvedPath, graph, database, branch, reset });
        const text =
          `Projected "${graph}" into ${adapter.name}\n` +
          `Database: ${result.database}\n` +
          `Events: ${result.eventsProcessed} (${result.nodeOps} node ops, ${result.edgeOps} edge ops)\n` +
          `Duration: ${result.durationMs}ms`;
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  );

  server.registerTool(
    "connector_query",
    {
      title: "Query Graph in " + adapter.name,
      description:
        `Run a ${adapter.queryLanguages.join(" or ")} query against a projected Backpack learning graph in ${adapter.name}. ` +
        `Database name = graph name with hyphens replaced by underscores (my-graph → my_graph). ` +
        `Cypher example: MATCH (p:Platform)-[r]->(a:API) RETURN p.name, type(r), a.name LIMIT 10. ` +
        `SQL example: SELECT count(*) FROM Platform. ` +
        `Cross-graph: project multiple graphs into the same database to query across them with UNION or WHERE bk_graph = 'name'.`,
      inputSchema: {
        database: z.string().describe("ArcadeDB database name (graph name with hyphens → underscores)"),
        query: z.string().describe("Cypher or SQL query"),
        language: z
          .enum(adapter.queryLanguages as [string, ...string[]])
          .optional()
          .describe(`Query language — ${adapter.queryLanguages[0]} (default) or ${adapter.queryLanguages.slice(1).join(", ")}`),
      },
    },
    async ({ database, query, language }) => {
      try {
        const lang = language ?? adapter.queryLanguages[0];
        const rows = await adapter.execute(database, lang, query);
        return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  );

  server.registerTool(
    "connector_schema",
    {
      title: "Graph Schema in " + adapter.name,
      description:
        `Get the schema of a projected Backpack learning graph in ${adapter.name}: ` +
        `all vertex types (node types), edge types, their properties, and projection state. ` +
        `Call this before writing queries to know what types and properties are available.`,
      inputSchema: {
        database: z.string().describe("Database name (graph name with hyphens → underscores)"),
      },
    },
    async ({ database }) => {
      try {
        const schema = await adapter.getSchema(database);
        return { content: [{ type: "text" as const, text: JSON.stringify(schema, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  );

  server.registerTool(
    "connector_synthesize",
    {
      title: "Synthesize Graphs in " + adapter.name,
      description:
        `Combine multiple Backpack learning graphs into a single unified graph using ${adapter.name}. ` +
        `Projects each source graph, runs a UNION query across all of them, and writes the result ` +
        `as a new Backpack learning graph visible in the viewer. ` +
        `Entities that appear in multiple source graphs are preserved as separate nodes with a bk_graph ` +
        `property showing their origin. Use connector_signals after synthesizing to see which entities appear in multiple graphs.`,
      inputSchema: {
        graphs: z.array(z.string()).describe("Learning graph names to combine (minimum 2)"),
        into: z.string().describe("Name for the output unified graph"),
        backpackPath: z.string().optional().describe("Backpack directory (uses active backpack if omitted)"),
        branch: z.string().optional().describe("Branch to read from (default: main)"),
        reset: z.boolean().optional().describe("Overwrite the output graph if it already exists"),
        projectFirst: z.boolean().optional().describe("Project source graphs before synthesizing (default: true)"),
        filter: z.string().optional().describe(
          "Cypher WHERE clause to filter which nodes are included, e.g. \"n:Platform OR n:API\". " +
          "Only nodes matching this filter are synthesized. Edges are included only when both endpoints match."
        ),
      },
    },
    async ({ graphs, into, backpackPath, branch, reset, projectFirst, filter }) => {
      try {
        if (graphs.length < 2) {
          return { content: [{ type: "text" as const, text: "Error: provide at least 2 graphs to synthesize." }] };
        }
        const resolvedPath = await resolveBackpackPath(backpackPath);
        const result = await synthesize(
          adapter,
          { backpackPath: resolvedPath, graphs, into, branch, reset, projectFirst, filter: filter ?? undefined },
          (msg) => process.stderr.write(msg + "\n"),
        );
        const text =
          `Synthesized ${result.sourceGraphs.length} graphs into "${result.outputGraph}"\n` +
          `Nodes: ${result.nodeCount}  Edges: ${result.edgeCount}  Duration: ${result.durationMs}ms\n\n` +
          `View: ${result.viewerUrl}\n\n` +
          `Note: duplicate entities from different source graphs are visible — each node has a bk_graph ` +
          `property showing which graph it came from. Run connector_signals to see cross-graph duplicates.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  );

  server.registerTool(
    "connector_signals",
    {
      title: "Cross-Graph Signals",
      description:
        `Detect entities that appear in multiple projected Backpack learning graphs — ` +
        `the cross-graph duplicate signal. These are candidates for entity resolution. ` +
        `When graphs are not specified, auto-detects all graphs with ${adapter.name} projections. ` +
        `The output shows which entity names appear in 2+ graphs, with their graph origins and properties. ` +
        `The output shows which entity names appear in 2+ graphs, with their graph origins and properties.`,
      inputSchema: {
        graphs: z.array(z.string()).optional().describe("Graphs to analyze (auto-detects all projected graphs if omitted)"),
        backpackPath: z.string().optional().describe("Backpack directory (uses active backpack if omitted)"),
        threshold: z.number().int().min(2).optional().describe("Min graph count to flag as a duplicate (default: 2)"),
      },
    },
    async ({ graphs, threshold }) => {
      try {
        const report = await detectCrossGraphSignals(adapter, { graphs, threshold });
        const text = JSON.stringify(report, null, 2);
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  );

  server.registerTool(
    "connector_signal_detect",
    {
      title: "Detect Connector Signals",
      description:
        `Run ArcadeDB-powered signal detectors across all projected learning graphs and merge results ` +
        `into the Backpack signal store. Detects: cross-graph entity duplicates with confidence scores, ` +
        `type drift (same entity name with different types across graphs), centrality hubs (unusually ` +
        `connected nodes), and cross-graph bridge nodes. Also runs any user-defined Cypher detectors ` +
        `configured in ~/.config/backpack/signals.json. ` +
        `After running, use backpack_signal_list to see all signals including these connector signals ` +
        `alongside the standard file-based signals.`,
      inputSchema: {
        backpackPath: z.string().optional().describe("Backpack directory (uses active backpack if omitted)"),
      },
    },
    async ({ backpackPath }) => {
      try {
        const resolvedPath = await resolveBackpackPath(backpackPath);
        const result = await runConnectorSignals(adapter, resolvedPath);
        const text = result.detected === 0
          ? "No connector signals detected. Ensure graphs are projected with connector_project first."
          : `Detected ${result.detected} connector signal${result.detected === 1 ? "" : "s"} and merged into signal store.\n` +
            `Use backpack_signal_list to view all signals.\n\n` +
            result.signals.slice(0, 5).map((s) => `• [${s.severity.toUpperCase()}] ${s.title}`).join("\n") +
            (result.signals.length > 5 ? `\n... and ${result.signals.length - 5} more` : "");
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  );

  server.registerTool(
    "connector_signals_show",
    {
      title: "Show Signals Panel Layout",
      description:
        `Read the current Signals panel widget layout from the active backpack. ` +
        `Returns the full SignalsViewSpec JSON so you can see what widgets exist before adding or updating one. ` +
        `Use connector_signals_add_widget to add or update a widget, connector_signals_remove_widget to remove one.`,
      inputSchema: {
        backpackPath: z.string().optional().describe("Backpack directory (uses active backpack if omitted)"),
      },
    },
    async ({ backpackPath }) => {
      try {
        const bp = await resolveBackpackPath(backpackPath);
        const filePath = path.join(bp, "signals-view.json");
        let spec: unknown = null;
        try { spec = JSON.parse(await fs.readFile(filePath, "utf8")); } catch { /* not configured yet */ }
        return { content: [{ type: "text" as const, text: JSON.stringify(spec, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  );

  server.registerTool(
    "connector_signals_add_widget",
    {
      title: "Add or Update a Signals Panel Widget",
      description:
        `Add a new widget or update an existing widget in the Signals panel. ` +
        `The panel hot-reloads within 3 seconds of this call. ` +
        `Widget types: stat-card, signal-cards, bar-chart, stacked-bar, line-chart, pie-chart, table. ` +
        `Position uses 1-based CSS grid: { col, row, colSpan, rowSpan }. Default grid is 3 columns. ` +
        `Query sources: "signals" (groupBy: kind|severity|category|graphNames) or "graphs" (groupBy: graphName|nodeType|edgeType). ` +
        `If the widget id already exists it will be replaced.`,
      inputSchema: {
        widget: z.object({
          id: z.string().describe("Unique widget id"),
          type: z.enum(["stat-card","signal-cards","bar-chart","stacked-bar","line-chart","pie-chart","table"]),
          title: z.string().describe("Widget header title"),
          position: z.object({ col: z.number(), row: z.number(), colSpan: z.number(), rowSpan: z.number() }),
          config: z.record(z.unknown()).describe("Widget-specific configuration"),
        }).describe("Full widget specification"),
        backpackPath: z.string().optional(),
      },
    },
    async ({ widget, backpackPath }) => {
      try {
        const bp = await resolveBackpackPath(backpackPath);
        const filePath = path.join(bp, "signals-view.json");
        let spec: { version: 1; grid: { columns: number; rowHeight: number; gap: number }; widgets: unknown[] } = {
          version: 1, grid: { columns: 3, rowHeight: 200, gap: 12 }, widgets: [],
        };
        try { spec = JSON.parse(await fs.readFile(filePath, "utf8")); } catch { /* first widget */ }
        const existing = spec.widgets as { id: string }[];
        const idx = existing.findIndex((w) => w.id === widget.id);
        if (idx >= 0) existing.splice(idx, 1, widget);
        else existing.push(widget);
        await fs.writeFile(filePath, JSON.stringify(spec, null, 2), "utf8");
        return { content: [{ type: "text" as const, text: `Widget "${widget.id}" saved. Signals panel will update within 3 seconds.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  );

  server.registerTool(
    "connector_signals_remove_widget",
    {
      title: "Remove a Signals Panel Widget",
      description: "Remove a widget from the Signals panel by its id.",
      inputSchema: {
        id: z.string().describe("Widget id to remove"),
        backpackPath: z.string().optional(),
      },
    },
    async ({ id, backpackPath }) => {
      try {
        const bp = await resolveBackpackPath(backpackPath);
        const filePath = path.join(bp, "signals-view.json");
        const spec = JSON.parse(await fs.readFile(filePath, "utf8")) as { widgets: { id: string }[] };
        const before = spec.widgets.length;
        spec.widgets = spec.widgets.filter((w) => w.id !== id);
        await fs.writeFile(filePath, JSON.stringify(spec, null, 2), "utf8");
        const removed = before - spec.widgets.length;
        return { content: [{ type: "text" as const, text: removed > 0 ? `Widget "${id}" removed.` : `Widget "${id}" not found.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  );

  server.registerTool(
    "connector_status",
    {
      title: "Projection Status",
      description:
        `Show the projection state for a graph — how many events have been projected, ` +
        `when it was last synced, and what database it lives in. ` +
        `Use this to check whether a projection is up to date before querying.`,
      inputSchema: {
        graph: z.string().describe("Learning graph name"),
        backpackPath: z.string().optional().describe("Backpack directory path (uses active backpack if omitted)"),
        database: z.string().optional().describe("Override database name"),
        branch: z.string().optional().describe("Branch (default: main)"),
      },
    },
    async ({ graph, backpackPath, database, branch }) => {
      try {
        const resolvedPath = await resolveBackpackPath(backpackPath);
        const db = database ?? sanitizeDatabaseName(graph);
        const br = branch ?? "main";
        const dbExists = await adapter.databaseExists(db);
        if (!dbExists) {
          return {
            content: [{
              type: "text" as const,
              text: `Graph "${graph}" has not been projected yet.\nRun connector_project first.`,
            }],
          };
        }
        const schema = await adapter.getSchema(db);
        const ordinal = await adapter.getLastOrdinal(db, graph, br);
        const text =
          `Graph: ${graph} → database: ${db} (branch: ${br})\n` +
          `Last projected ordinal: ${ordinal}\n` +
          `Projected at: ${schema.projection?.projectedAt ?? "unknown"}\n` +
          `Vertex types: ${schema.vertexTypes.map((t) => t.name).join(", ")}\n` +
          `Edge types: ${schema.edgeTypes.map((t) => t.name).join(", ")}`;
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  );
}
