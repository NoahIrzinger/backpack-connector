import type { GraphEvent, Node, Edge, NodeUpdateEvent, NodeRemoveEvent, NodeRetypeEvent, EdgeRemoveEvent } from "backpack-ontology/connector";
import { sanitizeIdent } from "./schema.js";

export interface SqlCmd {
  sql: string;
  params?: Record<string, unknown>;
}

function buildUpsert(typeName: string, bkId: string, props: Record<string, unknown>): SqlCmd {
  // w_bk_id is the WHERE condition — separate param so a node property
  // named "bk_id" can't overwrite it through the p_ loop below.
  const params: Record<string, unknown> = { w_bk_id: bkId };
  const setParts: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    const paramName = `p_${k}`;
    setParts.push(`${k} = :${paramName}`);
    params[paramName] = typeof v === "object" ? JSON.stringify(v) : v;
  }
  return {
    sql: `UPDATE ${typeName} SET ${setParts.join(", ")} UPSERT WHERE bk_id = :w_bk_id`,
    params,
  };
}

function nodeProps(node: Node, graph: string, branch: string): Record<string, unknown> {
  const props: Record<string, unknown> = {
    bk_id: node.id,
    bk_type: node.type,
    bk_graph: graph,
    bk_branch: branch,
    bk_created_at: node.createdAt,
    bk_updated_at: node.updatedAt,
  };
  for (const [k, v] of Object.entries(node.properties)) {
    if (v !== null && v !== undefined) props[sanitizeIdent(k)] = v;
  }
  return props;
}

function edgeProps(edge: Edge, graph: string, branch: string): Record<string, unknown> {
  const props: Record<string, unknown> = {
    bk_id: edge.id,
    bk_type: edge.type,
    bk_graph: graph,
    bk_branch: branch,
    bk_created_at: edge.createdAt,
    bk_updated_at: edge.updatedAt,
  };
  for (const [k, v] of Object.entries(edge.properties)) {
    if (v !== null && v !== undefined) props[sanitizeIdent(k)] = v;
  }
  return props;
}

export function translateNodeAdd(node: Node, graph: string, branch: string): SqlCmd {
  return buildUpsert(sanitizeIdent(node.type), node.id, nodeProps(node, graph, branch));
}

export function translateIndexUpsert(bkId: string, nodeTypeSafe: string): SqlCmd {
  return {
    sql: "UPDATE BackpackIndex SET bk_id = :bk_id, node_type = :node_type UPSERT WHERE bk_id = :bk_id",
    params: { bk_id: bkId, node_type: nodeTypeSafe },
  };
}

export function translateNodeUpdate(event: NodeUpdateEvent, typeSafe: string): SqlCmd {
  const params: Record<string, unknown> = { w_bk_id: event.id, p_bk_updated_at: event.ts };
  const setParts = ["bk_updated_at = :p_bk_updated_at"];
  for (const [k, v] of Object.entries(event.properties)) {
    if (v === null) continue; // null = delete — skip in v1 (property deletion is a v2 feature)
    const paramName = `p_${sanitizeIdent(k)}`;
    setParts.push(`${sanitizeIdent(k)} = :${paramName}`);
    params[paramName] = typeof v === "object" ? JSON.stringify(v) : v;
  }
  return {
    sql: `UPDATE ${typeSafe} SET ${setParts.join(", ")} WHERE bk_id = :w_bk_id`,
    params,
  };
}

export function translateNodeRemove(event: NodeRemoveEvent, typeSafe: string): SqlCmd[] {
  return [
    { sql: `DELETE FROM ${typeSafe} WHERE bk_id = :bk_id`, params: { bk_id: event.id } },
    { sql: "DELETE FROM BackpackIndex WHERE bk_id = :bk_id", params: { bk_id: event.id } },
  ];
}

export function translateEdgeAdd(
  edge: Edge,
  sourceTypeSafe: string,
  targetTypeSafe: string,
  graph: string,
  branch: string,
): SqlCmd[] {
  const props = edgeProps(edge, graph, branch);
  const typeName = sanitizeIdent(edge.type);
  const params: Record<string, unknown> = {
    p_bk_id: edge.id,
    p_source_id: edge.sourceId,
    p_target_id: edge.targetId,
  };
  const setParts: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    const paramName = `p_${k}`;
    setParts.push(`${k} = :${paramName}`);
    params[paramName] = typeof v === "object" ? JSON.stringify(v) : v;
  }
  return [
    { sql: `DELETE FROM ${typeName} WHERE bk_id = :p_bk_id`, params: { p_bk_id: edge.id } },
    {
      sql: `CREATE EDGE ${typeName} FROM (SELECT FROM ${sourceTypeSafe} WHERE bk_id = :p_source_id) TO (SELECT FROM ${targetTypeSafe} WHERE bk_id = :p_target_id) SET ${setParts.join(", ")}`,
      params,
    },
  ];
}

export function translateEdgeRemove(event: EdgeRemoveEvent, typeSafe: string): SqlCmd {
  return { sql: `DELETE FROM ${typeSafe} WHERE bk_id = :bk_id`, params: { bk_id: event.id } };
}

export function translateNodeRetype(event: NodeRetypeEvent): SqlCmd {
  // Update BackpackIndex to reflect the new type so subsequent edge lookups work.
  // The vertex itself stays in its original type bucket — full retype (delete+recreate)
  // is a v2 feature since it requires preserving all connected edges.
  return translateIndexUpsert(event.id, sanitizeIdent(event.type));
}

// Translate a GraphEvent into one or more SQL commands.
// Returns null for events that require async lookup (handled by the adapter directly).
// Returns "needs-lookup" for operations that need the node's type resolved first.
export type TranslateResult =
  | { kind: "cmds"; cmds: SqlCmd[]; nodeType?: string }
  | { kind: "needs-node-lookup"; bkId: string }  // node.update and node.remove
  | { kind: "needs-edge-lookup"; edge: Edge }      // edge.add: needs source+target types
  | { kind: "needs-edge-type-lookup"; edgeId: string } // edge.remove: needs edge type
  | null;

export function translateEvent(event: GraphEvent, graph: string, branch: string): TranslateResult {
  switch (event.op) {
    case "node.add":
      return {
        kind: "cmds",
        nodeType: event.node.type,
        cmds: [
          translateNodeAdd(event.node, graph, branch),
          translateIndexUpsert(event.node.id, sanitizeIdent(event.node.type)),
        ],
      };

    case "node.update":
      return { kind: "needs-node-lookup", bkId: event.id };

    case "node.remove":
      return { kind: "needs-node-lookup", bkId: event.id };

    case "node.retype":
      return {
        kind: "cmds",
        cmds: [translateNodeRetype(event)],
      };

    case "edge.add":
      return { kind: "needs-edge-lookup", edge: event.edge };

    case "edge.remove":
      return { kind: "needs-edge-type-lookup", edgeId: event.id };

    case "edge.retype":
      // v1: not implemented — edge retype requires finding the edge, deleting and recreating with new type
      process.stderr.write(`Warning: edge.retype not implemented in v1 connector — skipping\n`);
      return null;

    case "metadata.update":
    case "snapshot.label":
      return null;

    default:
      return null;
  }
}
