import type { ConnectorAdapter } from "./adapter.js";
import { project } from "./projector.js";
import { eventsFilePath, eventsFileExists } from "./event-reader.js";
import { sanitizeDatabaseName } from "./database-name.js";
import * as fs from "node:fs";

export interface DaemonTarget {
  backpackPath: string;
  graph: string;
  branch?: string;
  database?: string;
}

export interface DaemonOptions {
  adapter: ConnectorAdapter;
  targets: DaemonTarget[];
  pollMs?: number; // default 1000
  onSync?: (graph: string, eventsProcessed: number) => void;
  onError?: (graph: string, err: Error) => void;
}

export async function runDaemon(options: DaemonOptions): Promise<void> {
  const { adapter, targets, pollMs = 1000 } = options;

  const lastSizes = new Map<string, number>();

  while (true) {
    for (const target of targets) {
      const branch = target.branch ?? "main";
      const database = target.database ?? sanitizeDatabaseName(target.graph);
      const filePath = eventsFilePath(target.backpackPath, target.graph, branch);

      if (!(await eventsFileExists(target.backpackPath, target.graph, branch))) continue;

      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat) continue;

      const prevSize = lastSizes.get(filePath) ?? -1;
      if (stat.size === prevSize) continue; // no new bytes

      lastSizes.set(filePath, stat.size);

      try {
        const result = await project(adapter, {
          backpackPath: target.backpackPath,
          graph: target.graph,
          branch,
          database,
        });
        if (result.eventsProcessed > 0) {
          options.onSync?.(target.graph, result.eventsProcessed);
        }
      } catch (err) {
        options.onError?.(target.graph, err instanceof Error ? err : new Error(String(err)));
      }
    }

    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}
