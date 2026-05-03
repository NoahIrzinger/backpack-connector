import { describe, it, expect } from "vitest";
import { translateEvent, translateNodeAdd, translateIndexUpsert, translateEdgeAdd } from "../../src/adapters/arcadedb/translate.js";
import { sanitizeIdent } from "../../src/adapters/arcadedb/schema.js";

const node = {
  id: "n_abc123",
  type: "Platform",
  properties: { name: "Microsoft Graph", source: "https://example.com", source_type: "web" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const edge = {
  id: "e_xyz789",
  type: "USES",
  sourceId: "n_abc123",
  targetId: "n_def456",
  properties: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("sanitizeIdent", () => {
  it("passes alphanumeric names through", () => {
    expect(sanitizeIdent("Platform")).toBe("Platform");
  });
  it("replaces spaces with underscores", () => {
    expect(sanitizeIdent("Architectural Pattern")).toBe("Architectural_Pattern");
  });
  it("replaces hyphens with underscores", () => {
    expect(sanitizeIdent("my-type")).toBe("my_type");
  });
  it("prepends underscore for digit-leading names", () => {
    expect(sanitizeIdent("2024Type")).toBe("_2024Type");
  });
});

describe("translateNodeAdd", () => {
  it("produces UPSERT sql with w_bk_id as WHERE param", () => {
    const cmd = translateNodeAdd(node, "bp", "my-graph", "main");
    expect(cmd.sql).toContain("UPDATE Platform");
    expect(cmd.sql).toContain("UPSERT WHERE bk_id = :w_bk_id");
    expect(cmd.params!.w_bk_id).toBe("n_abc123");
  });

  it("stores bk_type with original unsanitized type", () => {
    const cmd = translateNodeAdd(node, "bp", "my-graph", "main");
    expect(cmd.params!.p_bk_type).toBe("Platform");
  });

  it("stores bk_backpack, bk_graph and bk_branch", () => {
    const cmd = translateNodeAdd(node, "my-backpack", "my-graph", "main");
    expect(cmd.params!.p_bk_backpack).toBe("my-backpack");
    expect(cmd.params!.p_bk_graph).toBe("my-graph");
    expect(cmd.params!.p_bk_branch).toBe("main");
  });

  it("sanitizes property keys", () => {
    const nodeWithSpace = { ...node, properties: { "bad key": "value" } };
    const cmd = translateNodeAdd(nodeWithSpace, "bp", "g", "main");
    expect(cmd.sql).toContain("bad_key = :p_bad_key");
  });

  it("w_bk_id is separate from p_bk_id so property named bk_id cannot overwrite WHERE param", () => {
    const nodeWithBkId = { ...node, properties: { bk_id: "malicious" } };
    const cmd = translateNodeAdd(nodeWithBkId, "bp", "g", "main");
    expect(cmd.params!.w_bk_id).toBe("n_abc123");
    expect(cmd.params!.p_bk_id).toBe("malicious");
  });
});

describe("translateIndexUpsert", () => {
  it("upserts into BackpackIndex with bk_id, node_type, and bk_backpack", () => {
    const cmd = translateIndexUpsert("n_abc123", "Platform", "my-backpack");
    expect(cmd.sql).toContain("UPDATE BackpackIndex");
    expect(cmd.params!.bk_id).toBe("n_abc123");
    expect(cmd.params!.node_type).toBe("Platform");
    expect(cmd.params!.backpack).toBe("my-backpack");
  });
});

describe("translateEdgeAdd", () => {
  it("produces DELETE then CREATE EDGE commands", () => {
    const cmds = translateEdgeAdd(edge, "Platform", "API", "bp", "my-graph", "main");
    expect(cmds).toHaveLength(2);
    expect(cmds[0].sql).toContain("DELETE FROM USES");
    expect(cmds[1].sql).toContain("CREATE EDGE USES");
  });

  it("references source and target by sanitized type", () => {
    const cmds = translateEdgeAdd(edge, "Platform", "API", "bp", "g", "main");
    expect(cmds[1].sql).toContain("SELECT FROM Platform WHERE bk_id = :p_source_id");
    expect(cmds[1].sql).toContain("SELECT FROM API WHERE bk_id = :p_target_id");
  });

  it("stores bk_type on the edge", () => {
    const cmds = translateEdgeAdd(edge, "Platform", "API", "bp", "g", "main");
    expect(cmds[1].params!.p_bk_type).toBe("USES");
  });

  it("stores bk_backpack on the edge", () => {
    const cmds = translateEdgeAdd(edge, "Platform", "API", "my-backpack", "g", "main");
    expect(cmds[1].params!.p_bk_backpack).toBe("my-backpack");
  });
});

describe("translateEvent", () => {
  it("returns cmds kind for node.add", () => {
    const result = translateEvent({ v: 1, ts: "2026-01-01T00:00:00.000Z", op: "node.add", node }, "bp", "g", "main");
    expect(result?.kind).toBe("cmds");
    expect((result as any).nodeType).toBe("Platform");
  });

  it("returns needs-node-lookup for node.update", () => {
    const result = translateEvent({ v: 1, ts: "t", op: "node.update", id: "n_abc", properties: { name: "New" } }, "bp", "g", "main");
    expect(result?.kind).toBe("needs-node-lookup");
    expect((result as any).bkId).toBe("n_abc");
  });

  it("returns needs-node-lookup for node.remove", () => {
    const result = translateEvent({ v: 1, ts: "t", op: "node.remove", id: "n_abc" }, "bp", "g", "main");
    expect(result?.kind).toBe("needs-node-lookup");
    expect((result as any).bkId).toBe("n_abc");
  });

  it("returns needs-edge-lookup for edge.add", () => {
    const result = translateEvent({ v: 1, ts: "t", op: "edge.add", edge }, "bp", "g", "main");
    expect(result?.kind).toBe("needs-edge-lookup");
    expect((result as any).edge.id).toBe("e_xyz789");
  });

  it("returns null for snapshot.label and metadata.update", () => {
    expect(translateEvent({ v: 1, ts: "t", op: "snapshot.label" }, "bp", "g", "main")).toBeNull();
    expect(translateEvent({ v: 1, ts: "t", op: "metadata.update", patch: {} }, "bp", "g", "main")).toBeNull();
  });
});
