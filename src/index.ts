export type { ConnectorAdapter, ConnectorSchema } from "./adapter.js";
export { project } from "./projector.js";
export type { ProjectOptions, ProjectResult } from "./projector.js";
export { runDaemon } from "./daemon.js";
export type { DaemonOptions, DaemonTarget } from "./daemon.js";
export { sanitizeDatabaseName } from "./database-name.js";
export { createAdapter, adapterFromEnv } from "./adapter-factory.js";
export type { AdapterConfig } from "./adapter-factory.js";
export { registerConnectorTools } from "./mcp/tools.js";

// Adapters
export { ArcadeDBAdapter, ArcadeDBClient } from "./adapters/arcadedb/index.js";
export type { ArcadeDBConfig } from "./adapters/arcadedb/index.js";
