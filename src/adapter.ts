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

  databaseExists(database: string): Promise<boolean>;
  createDatabase(database: string): Promise<void>;
  dropDatabase(database: string): Promise<void>;
  bootstrapSchema(database: string): Promise<void>;

  getLastOrdinal(database: string, backpackName: string, graph: string, branch: string): Promise<number>;
  setLastOrdinal(database: string, backpackName: string, graph: string, branch: string, ordinal: number): Promise<void>;

  applyEvent(event: GraphEvent, database: string, backpackName: string, graph: string, branch: string): Promise<void>;
  resetGraph(database: string, backpackName: string, graph: string, branch: string): Promise<void>;

  execute(database: string, language: string, query: string): Promise<Record<string, unknown>[]>;
  getSchema(database: string): Promise<ConnectorSchema>;
}
