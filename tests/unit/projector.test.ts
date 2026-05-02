import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { project } from "../../src/projector.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

function makeEvent(op: string, id: string): string {
  const ts = "2026-01-01T00:00:00.000Z";
  if (op === "node.add") {
    return JSON.stringify({ v: 1, ts, op, node: { id, type: "Test", properties: { name: id }, createdAt: ts, updatedAt: ts } });
  }
  if (op === "edge.add") {
    return JSON.stringify({ v: 1, ts, op, edge: { id, type: "CONNECTS", sourceId: "n_001", targetId: "n_002", properties: {}, createdAt: ts, updatedAt: ts } });
  }
  return JSON.stringify({ v: 1, ts, op, id });
}

function makeAdapter(opts: { exists?: boolean; lastOrdinal?: number } = {}) {
  return {
    name: "Mock", description: "Mock", queryLanguages: [] as string[],
    databaseExists: vi.fn().mockResolvedValue(opts.exists ?? false),
    createDatabase: vi.fn().mockResolvedValue(undefined),
    dropDatabase: vi.fn().mockResolvedValue(undefined),
    bootstrapSchema: vi.fn().mockResolvedValue(undefined),
    getLastOrdinal: vi.fn().mockResolvedValue(opts.lastOrdinal ?? 0),
    setLastOrdinal: vi.fn().mockResolvedValue(undefined),
    applyEvent: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue([]),
    getSchema: vi.fn().mockResolvedValue({ database: "test", projection: null, vertexTypes: [], edgeTypes: [] }),
  };
}

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bp-connector-test-"));
  const graphDir = path.join(tmpDir, "test-graph", "branches", "main");
  await fs.mkdir(graphDir, { recursive: true });
  await fs.writeFile(
    path.join(graphDir, "events.jsonl"),
    [
      makeEvent("node.add", "n_001"),
      makeEvent("node.add", "n_002"),
      makeEvent("edge.add", "e_001"),
    ].join("\n") + "\n",
  );
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("project", () => {
  it("creates database when it does not exist", async () => {
    const adapter = makeAdapter({ exists: false });
    await project(adapter, { backpackPath: tmpDir, graph: "test-graph" });
    expect(adapter.createDatabase).toHaveBeenCalledOnce();
    expect(adapter.dropDatabase).not.toHaveBeenCalled();
  });

  it("projects all events on first run", async () => {
    const adapter = makeAdapter();
    const result = await project(adapter, { backpackPath: tmpDir, graph: "test-graph" });
    expect(adapter.applyEvent).toHaveBeenCalledTimes(3);
    expect(result.eventsProcessed).toBe(3);
    expect(result.nodeOps).toBe(2);
    expect(result.edgeOps).toBe(1);
  });

  it("resumes from last ordinal — skips already-projected events", async () => {
    const adapter = makeAdapter({ exists: true, lastOrdinal: 2 });
    const result = await project(adapter, { backpackPath: tmpDir, graph: "test-graph" });
    expect(adapter.applyEvent).toHaveBeenCalledTimes(1);
    expect(result.eventsProcessed).toBe(1);
  });

  it("reset drops the database and projects all events from scratch", async () => {
    const adapter = makeAdapter({ exists: true, lastOrdinal: 3 });
    const result = await project(adapter, { backpackPath: tmpDir, graph: "test-graph", reset: true });
    expect(adapter.dropDatabase).toHaveBeenCalledOnce();
    expect(adapter.createDatabase).toHaveBeenCalledOnce();
    expect(adapter.applyEvent).toHaveBeenCalledTimes(3);
    expect(result.eventsProcessed).toBe(3);
  });

  it("throws with a clear message when events file does not exist", async () => {
    const adapter = makeAdapter();
    await expect(
      project(adapter, { backpackPath: tmpDir, graph: "nonexistent-graph" }),
    ).rejects.toThrow("Events file not found");
  });

  it("derives database name from graph name by default", async () => {
    const adapter = makeAdapter();
    const result = await project(adapter, { backpackPath: tmpDir, graph: "test-graph" });
    expect(result.database).toBe("test_graph");
  });

  it("uses provided database name override", async () => {
    const adapter = makeAdapter();
    const result = await project(adapter, { backpackPath: tmpDir, graph: "test-graph", database: "custom_db" });
    expect(result.database).toBe("custom_db");
    expect(adapter.createDatabase).toHaveBeenCalledWith("custom_db");
  });
});
