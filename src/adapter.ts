import type { GraphEvent } from "backpack-ontology/connector";

export interface ConnectorSchema {
  database: string;
  projection: {
    graph: string;
    branch: string;
    lastOrdinal: number;
    projectedAt: string;
  } | null;
  vertexTypes: Array<{ name: string; properties: string[] }>;
  edgeTypes: Array<{ name: string }>;
}

export interface ConnectorAdapter {
  readonly name: string;
  readonly description: string;
  readonly queryLanguages: readonly string[];

  // Database lifecycle — all methods must be idempotent
  databaseExists(database: string): Promise<boolean>;
  createDatabase(database: string): Promise<void>;
  dropDatabase(database: string): Promise<void>;
  bootstrapSchema(database: string): Promise<void>;

  // Projection state — persisted inside the target database
  getLastOrdinal(database: string, graph: string, branch: string): Promise<number>;
  setLastOrdinal(database: string, graph: string, branch: string, ordinal: number): Promise<void>;

  // Projection — called once per event, in ordinal order
  // Must be idempotent: replaying the same event twice must not corrupt state
  applyEvent(event: GraphEvent, database: string, graph: string, branch: string): Promise<void>;

  // Query
  execute(database: string, language: string, query: string): Promise<Record<string, unknown>[]>;
  getSchema(database: string): Promise<ConnectorSchema>;
}
