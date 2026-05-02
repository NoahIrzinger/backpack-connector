# backpack-connector

Unified graph database projection connector for Backpack. Projects Backpack event logs into graph databases and exposes a single MCP server that combines all backpack-ontology tools with connector query tools.

## Tech Stack

- TypeScript, Node.js >= 18, ES modules
- Depends on `backpack-ontology` at runtime (imports `createMcpServer`, `loadConfig`, connector types)
- `@modelcontextprotocol/sdk` as peerDependency (resolves from backpack-ontology's copy to avoid type conflicts)
- `zod` for MCP tool input schemas

## Development

```bash
npm install
npm run build   # tsc → dist/
npm run dev     # tsc --watch
```

## Architecture

```
src/
  adapter.ts           # ConnectorAdapter interface — the contract all adapters implement
  event-reader.ts      # Reads events.jsonl per docs/event-log-format.md spec
  projector.ts         # Generic projection engine: streams events, calls adapter.applyEvent()
  daemon.ts            # Polls event logs, projects incrementally on change
  database-name.ts     # sanitizeDatabaseName: graph name → safe DB identifier
  adapter-factory.ts   # Creates adapter from config/env vars
  adapters/
    arcadedb/
      client.ts        # ArcadeDB REST client (fetch-based, 30s timeout, parameterized queries)
      schema.ts        # Schema management: lazy CREATE VERTEX/EDGE TYPE, BackpackIndex
      translate.ts     # GraphEvent → SQL commands (parameterized, w_bk_id for WHERE)
      index.ts         # ArcadeDBAdapter implementing ConnectorAdapter
  mcp/
    tools.ts           # registerConnectorTools(server, adapter): adds 4 tools to McpServer
  index.ts             # Public exports
bin/
  mcp-server.ts        # THE unified MCP: createMcpServer() + registerConnectorTools() + connect
  cli.ts               # project / query / schema / daemon / mcp-config subcommands
```

## Key design decisions

**One MCP server.** `bin/mcp-server.ts` calls `createMcpServer()` from backpack-ontology (gets all 86 backpack tools), then calls `registerConnectorTools(server, adapter)` to add 4 connector tools, then connects to stdio. One process, one config entry in Claude.

**ConnectorAdapter interface.** Everything the generic engine needs from a backend: lifecycle (create/drop/exists/bootstrap), state (getLastOrdinal/setLastOrdinal), projection (applyEvent per event), query (execute/getSchema). Adding a new backend = one file implementing this interface + one line in adapter-factory.ts.

**Event-reader uses parseEvent from backpack-ontology.** Not raw JSON.parse. Gets version validation for free. Fails clearly if EVENT_SCHEMA_VERSION mismatches instead of silently misprocessing.

**BackpackIndex document type in ArcadeDB.** Maps bk_id → sanitized type name. Required because ArcadeDB has no base V type — edge creation needs to know which vertex type each endpoint belongs to. Warmed into memory cache on bootstrapSchema.

**Parameterized queries throughout.** All user-supplied values go into ArcadeDB params (`:param_name` syntax), never string-interpolated. `w_bk_id` is the WHERE condition param, `p_*` are property params — kept separate so a node property named "bk_id" can't overwrite the lookup key.

**Schema sets scoped by database.** `SchemaManager` tracks known vertex/edge types per database, so the same adapter instance can project multiple graphs into different databases without DDL skipping.

## ArcadeDB notes

- `CREATE VERTEX TYPE IF NOT EXISTS` is NOT supported — use try/catch
- `DELETE EDGE TypeName WHERE` is NOT valid — use `DELETE FROM TypeName WHERE`
- `V` base class does NOT exist — BackpackIndex handles cross-type bk_id lookups
- Parameterized queries use `:name` syntax in both command and query endpoints
- Database create/drop uses `POST /api/v1/server` with `{"language":"sql","command":"CREATE DATABASE name"}`

## MCP tools exposed

| Tool | Description |
|---|---|
| `connector_project` | Project a graph (incremental, or reset) |
| `connector_query` | Cypher/SQL query against a projected graph |
| `connector_schema` | Schema + projection state for a database |
| `connector_status` | Human-readable projection summary |

## Adding a new adapter

1. Create `src/adapters/<name>/index.ts` implementing `ConnectorAdapter`
2. Export the class from `src/adapters/<name>/index.ts`
3. Add a case to `src/adapter-factory.ts`
4. Export from `src/index.ts`

No changes needed to CLI, daemon, MCP tools, or MCP server.
