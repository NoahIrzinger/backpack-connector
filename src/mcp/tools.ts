import type { McpServer } from "backpack-ontology/connector";
import { z } from "zod";
import { getActiveBackpack } from "backpack-ontology/connector";
import type { ConnectorAdapter } from "../adapter.js";
import { project } from "../projector.js";
import { sanitizeDatabaseName } from "../database-name.js";

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
