# backpack-connector

Graph database projection connectors for [Backpack](https://backpackontology.com) learning graphs.

Projects Backpack event logs into graph databases for Cypher traversals, vector search, and graph analytics. Includes a unified MCP server that combines all backpack-ontology tools with connector query tools — one server, one config entry in Claude.

## Supported adapters

| Adapter | Languages | Status |
|---|---|---|
| `arcadedb` | Cypher (OpenCypher), SQL, Gremlin | stable |

## Installation

```bash
npm install -g backpack-connector
```

Requires Node.js >= 18 and a running ArcadeDB instance. See [ArcadeDB quickstart](#arcadedb-quickstart) below.

## Quick start

```bash
# 1. Project a graph into ArcadeDB
backpack-connector project --graph my-graph

# 2. Query it
backpack-connector query --graph my-graph \
  --cypher "MATCH (n)-[r]->(m) RETURN n.name, type(r), m.name LIMIT 10"

# 3. Wire Claude to use the unified MCP server
backpack-connector mcp-config
# Copy the output into ~/.claude/settings.json
```

## Commands

### `project`

Project a Backpack learning graph into the connected graph database. Incremental — only processes new events since the last run.

```bash
backpack-connector project \
  --graph <name>              # required: graph name
  [--backpack-path <path>]    # defaults to active backpack
  [--database <name>]         # override database name (default: graph name, hyphens → underscores)
  [--branch <branch>]         # default: main
  [--adapter arcadedb]        # default: arcadedb, or BACKPACK_ADAPTER env var
  [--reset]                   # drop and recreate database before projecting
```

**Cross-graph queries** — project multiple graphs into one database:

```bash
backpack-connector project --graph project-alpha --database team_graphs
backpack-connector project --graph project-beta  --database team_graphs
# Now query across both with WHERE n.bk_graph = 'project-alpha'
```

### `query`

Run a Cypher or SQL query against a projected graph.

```bash
backpack-connector query \
  --graph <name> | --database <name>   # required
  --cypher <query>                     # Cypher (OpenCypher)
  --sql <query>                        # SQL
  [--table]                            # ASCII table output (default: JSON)
  [--adapter arcadedb]

# Examples
backpack-connector query --graph my-graph \
  --cypher "MATCH (p:Platform)-[r]->(a:API) RETURN p.name, type(r), a.name"

backpack-connector query --graph my-graph \
  --sql "SELECT name, type FROM schema:types WHERE type = 'vertex'"
```

### `schema`

Show vertex types, edge types, and projection state for a projected graph.

```bash
backpack-connector schema --graph <name> [--adapter arcadedb]
```

### `daemon`

Watch for new events and project them continuously (polls every 1s).

```bash
backpack-connector daemon \
  --graph <name>               # comma-separated for multiple: graph-a,graph-b
  [--backpack-path <path>]
  [--adapter arcadedb]
  [--poll <ms>]                # default: 1000
```

### `mcp-config`

Print the Claude MCP configuration snippet for the unified MCP server.

```bash
backpack-connector mcp-config [--name backpack] [--adapter arcadedb]
```

Output goes directly into `~/.claude/settings.json`. This server includes all 86+ backpack-ontology tools plus `connector_project`, `connector_query`, `connector_schema`, and `connector_status`.

## Unified MCP server

The MCP server (`backpack-connector-mcp`) is the recommended way to use this package with Claude. It runs one server process that exposes:

- All backpack-ontology tools (graph management, KB, signals, mining, sync, etc.)
- `connector_project` — project a graph from inside a conversation
- `connector_query` — run Cypher/SQL from inside a conversation
- `connector_schema` — inspect schema from inside a conversation
- `connector_status` — check projection state from inside a conversation

**Claude Code** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "backpack": {
      "command": "npx",
      "args": ["backpack-connector-mcp"],
      "env": {
        "BACKPACK_ADAPTER": "arcadedb",
        "ARCADEDB_URL": "http://localhost:2480",
        "ARCADEDB_USERNAME": "root",
        "ARCADEDB_PASSWORD": "arcadedb"
      }
    }
  }
}
```

If you have a separate `backpack-ontology` entry in your MCP config, remove it — the connector server is a superset.

## ArcadeDB quickstart

ArcadeDB requires Java 11+. Java 21 recommended.

```bash
# Download and extract
curl -L -o /tmp/arcadedb.tar.gz \
  https://github.com/ArcadeData/arcadedb/releases/download/26.4.2/arcadedb-26.4.2.tar.gz
tar -xzf /tmp/arcadedb.tar.gz -C ~/
rm /tmp/arcadedb.tar.gz

# Start (run from its own directory)
cd ~/arcadedb-26.4.2
JAVA_OPTS="-Darcadedb.server.rootPassword=<your-password>" ./bin/server.sh

# Studio UI at http://localhost:2480
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `BACKPACK_ADAPTER` | `arcadedb` | Adapter to use |
| `ARCADEDB_URL` | `http://localhost:2480` | ArcadeDB server URL |
| `ARCADEDB_USERNAME` | `root` | ArcadeDB username |
| `ARCADEDB_PASSWORD` | `arcadedb` | ArcadeDB password |

## Programmatic use

```typescript
import { project, createAdapter, registerConnectorTools } from "backpack-connector";
import { createMcpServer, loadConfig } from "backpack-ontology";

// Project a graph
const adapter = createAdapter({ adapter: "arcadedb" });
const result = await project(adapter, {
  backpackPath: "/path/to/backpack",
  graph: "my-graph",
});

// Build a unified MCP server
const config = await loadConfig();
const server = await createMcpServer({ mode: "local", dataDir: config.dataDir });
registerConnectorTools(server, adapter);
await server.connect(transport);
```

## Architecture

The event log is the source of truth. ArcadeDB is a derived projection. See [`docs/event-log-format.md`](https://github.com/NoahIrzinger/backpack-ontology/blob/main/docs/event-log-format.md) for the full protocol spec.

```
Backpack learning graphs (events.jsonl)
  ↓  backpack-connector project
ArcadeDB projection (Cypher / SQL queryable)
  ↓  backpack-connector synthesize
Unified learning graph (viewable, traversable)
```

Adding a new graph database backend: implement `ConnectorAdapter` in `src/adapters/<name>/`, register in `src/adapter-factory.ts`. The CLI, daemon, and MCP server work without changes.

## License

Apache 2.0
