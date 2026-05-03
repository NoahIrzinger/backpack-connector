export function sanitizeDatabaseName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  return /^[0-9]/.test(safe) ? `_${safe}` : safe;
}

export const DEFAULT_DATABASE = "backpack";

export function backpackNameFromPath(backpackPath: string): string {
  const trimmed = backpackPath.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/).filter(Boolean);
  const name = parts[parts.length - 1] ?? "unknown";
  return name.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, "_");
}
