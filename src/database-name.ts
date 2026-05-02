export function sanitizeDatabaseName(graphName: string): string {
  const safe = graphName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  return /^[0-9]/.test(safe) ? `_${safe}` : safe;
}
