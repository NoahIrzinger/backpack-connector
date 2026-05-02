import type { ConnectorAdapter } from "./adapter.js";
import { ArcadeDBAdapter, ArcadeDBClient } from "./adapters/arcadedb/index.js";

export interface AdapterConfig {
  adapter: string;
  arcadedbUrl?: string;
  arcadedbUsername?: string;
  arcadedbPassword?: string;
}

export function createAdapter(config: AdapterConfig): ConnectorAdapter {
  switch (config.adapter.toLowerCase()) {
    case "arcadedb":
      return new ArcadeDBAdapter(
        new ArcadeDBClient({
          url: config.arcadedbUrl ?? process.env.ARCADEDB_URL ?? "http://localhost:2480",
          username: config.arcadedbUsername ?? process.env.ARCADEDB_USERNAME ?? "root",
          password: config.arcadedbPassword ?? process.env.ARCADEDB_PASSWORD ?? "arcadedb",
        }),
      );
    default:
      throw new Error(
        `Unknown adapter: "${config.adapter}". Available adapters: arcadedb\n` +
        `Set BACKPACK_ADAPTER=arcadedb or pass --adapter arcadedb.`,
      );
  }
}

export function adapterFromEnv(): ConnectorAdapter {
  return createAdapter({ adapter: process.env.BACKPACK_ADAPTER ?? "arcadedb" });
}
