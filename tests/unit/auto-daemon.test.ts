import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bp-daemon-test-"));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeAdapter(opts: { exists?: boolean } = {}) {
  return {
    name: "Mock", description: "Mock", queryLanguages: [] as string[],
    databaseExists: vi.fn().mockResolvedValue(opts.exists ?? false),
    createDatabase: vi.fn().mockResolvedValue(undefined),
    dropDatabase: vi.fn().mockResolvedValue(undefined),
    bootstrapSchema: vi.fn().mockResolvedValue(undefined),
    getLastOrdinal: vi.fn().mockResolvedValue(0),
    setLastOrdinal: vi.fn().mockResolvedValue(undefined),
    applyEvent: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue([]),
    getSchema: vi.fn().mockResolvedValue({ database: "test", projection: null, vertexTypes: [], edgeTypes: [] }),
  };
}

describe("daemon file-size polling", () => {
  it("triggers projection when file size grows", async () => {
    const { runDaemon } = await import("../../src/daemon.js");
    const graphDir = path.join(tmpDir, "test-graph", "branches", "main");
    await fs.mkdir(graphDir, { recursive: true });
    const eventsFile = path.join(graphDir, "events.jsonl");
    const event = JSON.stringify({ v: 1, ts: new Date().toISOString(), op: "node.add",
      node: { id: "n_1", type: "T", properties: { name: "x" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    await fs.writeFile(eventsFile, event + "\n");

    const adapter = makeAdapter();
    let syncFired = false;

    const daemonPromise = runDaemon({
      adapter,
      targets: [{ backpackPath: tmpDir, graph: "test-graph" }],
      pollMs: 100,
      onSync: () => { syncFired = true; },
    });

    // Write a new event to trigger size change
    await new Promise(r => setTimeout(r, 300));
    await fs.appendFile(eventsFile, event + "\n");
    await new Promise(r => setTimeout(r, 500));

    expect(adapter.applyEvent).toHaveBeenCalled();
    expect(syncFired).toBe(true);

    daemonPromise.catch(() => {});
  });
});

describe("plist generation", () => {
  it("installed plist contains node path, dist/bin/cli.js, and env vars", async () => {
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.backpack.connector-daemon.plist");
    const content = await fs.readFile(plistPath, "utf8").catch(() => null);
    if (!content) {
      // Daemon not installed — skip (only runs if daemon-install was called first)
      return;
    }
    expect(content).toContain(process.execPath);
    expect(content).toContain("dist/bin/cli.js");
    expect(content).toContain("daemon --backpack-path");
    expect(content).toContain("ARCADEDB_URL");
    expect(content).toContain("KeepAlive");
    expect(content).toContain("RunAtLoad");
  });
});
