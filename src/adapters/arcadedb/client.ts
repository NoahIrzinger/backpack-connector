export interface ArcadeDBConfig {
  url: string;
  username: string;
  password: string;
}

interface CommandResponse {
  result?: unknown[];
  error?: string;
  detail?: string;
  exception?: string;
}

const TIMEOUT_MS = 30_000;

export class ArcadeDBClient {
  private auth: string;

  constructor(private config: ArcadeDBConfig) {
    this.auth = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(TIMEOUT_MS);
  }

  async databaseExists(name: string): Promise<boolean> {
    const res = await fetch(
      `${this.config.url}/api/v1/query/${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { Authorization: this.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ language: "sql", command: "SELECT 1" }),
        signal: this.signal(),
      },
    );
    if (res.ok) return true;
    const body = (await res.json().catch(() => ({}))) as CommandResponse;
    if (typeof body.detail === "string" && body.detail.includes("is not available")) return false;
    throw new Error(`databaseExists failed: ${body.detail ?? res.status}`);
  }

  async createDatabase(name: string): Promise<void> {
    const res = await fetch(`${this.config.url}/api/v1/server`, {
      method: "POST",
      headers: { Authorization: this.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ language: "sql", command: `CREATE DATABASE ${name}` }),
      signal: this.signal(),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as CommandResponse;
      throw new Error(`Create database failed: ${body.detail ?? res.status}`);
    }
  }

  async dropDatabase(name: string): Promise<void> {
    const res = await fetch(`${this.config.url}/api/v1/server`, {
      method: "POST",
      headers: { Authorization: this.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ language: "sql", command: `DROP DATABASE ${name}` }),
      signal: this.signal(),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as CommandResponse;
      throw new Error(`Drop database failed: ${body.detail ?? res.status}`);
    }
  }

  async command(database: string, sql: string, params?: Record<string, unknown>): Promise<unknown[]> {
    const res = await fetch(
      `${this.config.url}/api/v1/command/${encodeURIComponent(database)}`,
      {
        method: "POST",
        headers: { Authorization: this.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ language: "sql", command: sql, ...(params ? { params } : {}) }),
        signal: this.signal(),
      },
    );
    const body = (await res.json().catch(() => ({}))) as CommandResponse;
    if (!res.ok) {
      throw new Error(`SQL failed (${res.status}): ${body.detail ?? body.error ?? sql.slice(0, 80)}`);
    }
    return (body.result as unknown[]) ?? [];
  }

  async query(database: string, sql: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const res = await fetch(
      `${this.config.url}/api/v1/query/${encodeURIComponent(database)}`,
      {
        method: "POST",
        headers: { Authorization: this.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ language: "sql", command: sql, ...(params ? { params } : {}) }),
        signal: this.signal(),
      },
    );
    const body = (await res.json().catch(() => ({}))) as CommandResponse;
    if (!res.ok) {
      throw new Error(`Query failed (${res.status}): ${body.detail ?? body.error ?? sql.slice(0, 80)}`);
    }
    return (body.result as Record<string, unknown>[]) ?? [];
  }

  // Execute a query in any ArcadeDB-supported language (opencypher, sql, gremlin, etc.)
  async execute(database: string, language: string, queryText: string): Promise<Record<string, unknown>[]> {
    const res = await fetch(
      `${this.config.url}/api/v1/command/${encodeURIComponent(database)}`,
      {
        method: "POST",
        headers: { Authorization: this.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ language, command: queryText }),
        signal: this.signal(),
      },
    );
    const body = (await res.json().catch(() => ({}))) as CommandResponse;
    if (!res.ok) {
      throw new Error(`Query failed (${res.status}): ${body.detail ?? body.error ?? queryText.slice(0, 80)}`);
    }
    return (body.result as Record<string, unknown>[]) ?? [];
  }
}
