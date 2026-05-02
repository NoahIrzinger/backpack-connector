import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { parseEvent, EVENT_SCHEMA_VERSION } from "backpack-ontology/connector";
import type { GraphEvent } from "backpack-ontology/connector";

export interface EventRecord {
  event: GraphEvent;
  ordinal: number; // 1-based line number — used for incremental projection state
}

export function eventsFilePath(backpackPath: string, graph: string, branch: string): string {
  return path.join(backpackPath, graph, "branches", branch, "events.jsonl");
}

export async function eventsFileExists(backpackPath: string, graph: string, branch: string): Promise<boolean> {
  return fs.promises.access(eventsFilePath(backpackPath, graph, branch)).then(() => true).catch(() => false);
}

export async function* streamEvents(
  filePath: string,
  fromOrdinal = 0,
): AsyncGenerator<EventRecord> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let ordinal = 0;
  for await (const line of rl) {
    ordinal++;
    if (ordinal <= fromOrdinal) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: GraphEvent;
    try {
      event = parseEvent(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unknown schema version")) {
        throw new Error(
          `Event at ordinal ${ordinal} uses schema version incompatible with EVENT_SCHEMA_VERSION=${EVENT_SCHEMA_VERSION}. ` +
          `Update backpack-connector to a version that supports the newer format.`
        );
      }
      process.stderr.write(`Warning: skipping unparseable event at ordinal ${ordinal}: ${msg}\n`);
      continue;
    }

    yield { event, ordinal };
  }
}

