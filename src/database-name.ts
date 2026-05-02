// Derives a safe database name from a graph name.
// Rules: lowercase alphanumeric + underscores only, must not start with a digit.
// Safe for ArcadeDB, Neo4j, FalkorDB, and most graph databases.
export function sanitizeDatabaseName(graphName: string): string {
  const safe = graphName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  return /^[0-9]/.test(safe) ? `_${safe}` : safe;
}
