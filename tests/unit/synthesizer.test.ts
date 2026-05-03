import { describe, it, expect, vi, beforeEach } from "vitest";
import { synthesize } from "../../src/synthesizer.js";

vi.mock("backpack-ontology", () => ({
  Backpack: {
    fromActiveBackpack: vi.fn().mockResolvedValue({
      ontologyExists: vi.fn().mockResolvedValue(false),
      createOntologyFromData: vi.fn().mockResolvedValue(undefined),
      deleteOntology: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

function makeAdapter(nodes: Record<string, unknown>[] = []) {
  return {
    name: "Mock", description: "Mock", queryLanguages: [] as string[],
    databaseExists: vi.fn().mockResolvedValue(true),
    createDatabase: vi.fn().mockResolvedValue(undefined),
    dropDatabase: vi.fn().mockResolvedValue(undefined),
    bootstrapSchema: vi.fn().mockResolvedValue(undefined),
    getLastOrdinal: vi.fn().mockResolvedValue(0),
    setLastOrdinal: vi.fn().mockResolvedValue(undefined),
    applyEvent: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockImplementation((db, lang, query) => {
      if (String(query).startsWith("MATCH (n)")) return Promise.resolve(nodes.map(n => ({ n })));
      return Promise.resolve([]);
    }),
    getSchema: vi.fn().mockResolvedValue({ database: "test", projection: null, vertexTypes: [], edgeTypes: [] }),
  };
}

describe("synthesize filter", () => {
  it("without filter queries all nodes", async () => {
    const adapter = makeAdapter();
    await synthesize(adapter, { backpackPath: "/fake", graphs: ["g"], into: "out", projectFirst: false });
    const nodeQuery = adapter.execute.mock.calls.find(c => String(c[2]).includes("MATCH (n)"));
    expect(nodeQuery).toBeTruthy();
    expect(nodeQuery![2]).toContain("MATCH (n) WHERE n.bk_id IS NOT NULL");
  });

  it("with filter appends AND clause to node query", async () => {
    const adapter = makeAdapter();
    await synthesize(adapter, {
      backpackPath: "/fake", graphs: ["g"], into: "out",
      filter: "n:Platform OR n:API", projectFirst: false,
    });
    const nodeQuery = adapter.execute.mock.calls.find(c => String(c[2]).includes("MATCH (n)"));
    expect(nodeQuery![2]).toContain("AND (n:Platform OR n:API)");
  });

  it("writes output graph via createOntologyFromData", async () => {
    const { Backpack } = await import("backpack-ontology");
    const mockBp = await (Backpack.fromActiveBackpack as ReturnType<typeof vi.fn>)();
    (mockBp.createOntologyFromData as ReturnType<typeof vi.fn>).mockClear();

    const adapter = makeAdapter();
    await synthesize(adapter, { backpackPath: "/fake", graphs: ["g"], into: "my-kg", projectFirst: false });
    expect(mockBp.createOntologyFromData).toHaveBeenCalledWith("my-kg", expect.objectContaining({
      metadata: expect.objectContaining({ name: "my-kg" }),
    }));
  });

  it("throws if output graph already exists and reset is false", async () => {
    const { Backpack } = await import("backpack-ontology");
    const mockBp = await (Backpack.fromActiveBackpack as ReturnType<typeof vi.fn>)();
    (mockBp.ontologyExists as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    const adapter = makeAdapter();
    await expect(
      synthesize(adapter, { backpackPath: "/fake", graphs: ["g"], into: "exists", projectFirst: false }),
    ).rejects.toThrow('already exists');
  });

  it("deletes and recreates when reset is true", async () => {
    const { Backpack } = await import("backpack-ontology");
    const mockBp = await (Backpack.fromActiveBackpack as ReturnType<typeof vi.fn>)();
    (mockBp.ontologyExists as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    (mockBp.deleteOntology as ReturnType<typeof vi.fn>).mockClear();
    (mockBp.createOntologyFromData as ReturnType<typeof vi.fn>).mockClear();

    const adapter = makeAdapter();
    await synthesize(adapter, { backpackPath: "/fake", graphs: ["g"], into: "exists", projectFirst: false, reset: true });
    expect(mockBp.deleteOntology).toHaveBeenCalledWith("exists");
    expect(mockBp.createOntologyFromData).toHaveBeenCalled();
  });
});
