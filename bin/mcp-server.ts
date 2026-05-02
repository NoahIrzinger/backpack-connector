#!/usr/bin/env node
// The unified Backpack MCP server.
// Includes all backpack-ontology tools (graph management, KB, signals, etc.)
// PLUS connector tools (project, query, schema, status) for the configured adapter.
//
// Claude Code settings.json:
//   "mcpServers": {
//     "backpack": {
//       "command": "node",
//       "args": ["/path/to/dist/bin/mcp-server.js"],
//       "env": {
//         "BACKPACK_ADAPTER": "arcadedb",
//         "ARCADEDB_URL": "http://localhost:2480",
//         "ARCADEDB_USERNAME": "root",
//         "ARCADEDB_PASSWORD": "arcadedb"
//       }
//     }
//   }
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, loadConfig } from "backpack-ontology";
import { adapterFromEnv } from "../src/adapter-factory.js";
import { registerConnectorTools } from "../src/mcp/tools.js";

async function main(): Promise<void> {
  const config = await loadConfig();

  // Create the backpack-ontology MCP server with all its tools
  const server = await createMcpServer({ mode: "local", dataDir: config.dataDir });

  // Register connector tools on the same server — one MCP, all tools
  const adapter = adapterFromEnv();
  registerConnectorTools(server, adapter);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `Backpack + ${adapter.name} connector MCP server running on stdio\n`,
  );
}

async function gracefulShutdown(): Promise<void> {
  process.exit(0);
}

process.on("SIGINT", () => { gracefulShutdown(); });
process.on("SIGTERM", () => { gracefulShutdown(); });

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
