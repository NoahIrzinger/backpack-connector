import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { Backpack, EventSourcedBackend } from "backpack-ontology";
import type { ConnectorAdapter } from "./adapter.js";
import { runDaemon, type DaemonTarget } from "./daemon.js";
import { adapterFromEnv } from "./adapter-factory.js";

const GRAPH_RESCAN_MS = 30_000;
const PLIST_LABEL = "com.backpack.connector-daemon";

export async function runAutoDaemon(
  adapter: ConnectorAdapter,
  backpackPath: string,
  pollMs = 1000,
): Promise<void> {
  const backend = new EventSourcedBackend(undefined, { graphsDirOverride: backpackPath });
  const bp = new Backpack(backend);
  await bp.initialize();

  const targets: DaemonTarget[] = [];

  async function rescanGraphs() {
    try {
      const graphs = await bp.listOntologies();
      const current = new Set(targets.map((t) => t.graph));
      for (const g of graphs) {
        if (!current.has(g.name)) {
          targets.push({ backpackPath, graph: g.name });
          process.stderr.write(`[daemon] watching: ${g.name}\n`);
        }
      }
    } catch { /* backpack may not be readable yet */ }
  }

  await rescanGraphs();
  const rescanTimer = setInterval(rescanGraphs, GRAPH_RESCAN_MS);

  process.stderr.write(`[daemon] projecting ${targets.length} graph(s) from ${backpackPath}\n`);
  process.stderr.write(`[daemon] adapter: ${adapter.name}\n`);

  process.on("SIGINT", () => { clearInterval(rescanTimer); process.exit(0); });
  process.on("SIGTERM", () => { clearInterval(rescanTimer); process.exit(0); });

  await runDaemon({
    adapter,
    targets,
    pollMs,
    onSync: (graph, count) =>
      process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${graph}: +${count} events projected\n`),
    onError: (graph, err) =>
      process.stderr.write(`[daemon][error] ${graph}: ${err.message}\n`),
  });
}

function plistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
}

function xmlEscape(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function resolveDaemonBin(): string {
  // Resolve to a stable node symlink rather than the versioned NVM path so the
  // plist survives a Node version upgrade. Falls back to process.execPath.
  const stable = (() => {
    try {
      const r = child_process.execSync("command -v node 2>/dev/null", { encoding: "utf8" }).trim();
      return r || process.execPath;
    } catch {
      return process.execPath;
    }
  })();
  const local = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../bin/cli.js",
  );
  return `${stable} ${local}`;
}

function assertMacOS(): void {
  if (process.platform !== "darwin") {
    throw new Error(
      `Daemon installation is only supported on macOS (launchctl). ` +
      `On Linux, use: systemd or cron. On Windows, use: Task Scheduler. ` +
      `Run 'backpack-connector daemon' directly to start without installation.`
    );
  }
}

export async function installDaemon(opts: {
  backpackPath: string;
  adapterEnv?: Record<string, string>;
}): Promise<string> {
  const binCmd = resolveDaemonBin();
  const env: Record<string, string> = {
    BACKPACK_ADAPTER: "arcadedb",
    ARCADEDB_URL: "http://localhost:2480",
    ARCADEDB_USERNAME: "root",
    ARCADEDB_PASSWORD: "arcadedb",
    ...opts.adapterEnv,
  };

  const envEntries = Object.entries(env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`)
    .join("\n");

  // Use double-quote wrapping and escape the path for shell safety
  const escapedPath = opts.backpackPath.replace(/"/g, '\\"');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${xmlEscape(binCmd)} daemon --backpack-path "${xmlEscape(escapedPath)}"</string>
  </array>
  <key>EnvironmentVariables</key><dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/backpack-connector-daemon.log</string>
  <key>StandardErrorPath</key><string>/tmp/backpack-connector-daemon.log</string>
  <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
`;

  assertMacOS();
  const dest = plistPath();
  await fs.writeFile(dest, plist, "utf8");

  try {
    child_process.execSync(`launchctl unload "${dest}" 2>/dev/null || true`);
    child_process.execSync(`launchctl load "${dest}"`);
  } catch (e) {
    throw new Error(`launchctl load failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return dest;
}

export async function uninstallDaemon(): Promise<void> {
  assertMacOS();
  const dest = plistPath();
  try {
    child_process.execSync(`launchctl unload "${dest}" 2>/dev/null || true`);
  } catch { /* already unloaded */ }
  await fs.unlink(dest).catch(() => {});
}

export async function daemonStatus(): Promise<{ installed: boolean; running: boolean; logPath: string }> {
  const dest = plistPath();
  const installed = await fs.access(dest).then(() => true).catch(() => false);
  let running = false;
  if (installed) {
    try {
      const out = child_process.execSync(
        `launchctl list ${PLIST_LABEL}`,
        { stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" },
      );
      running = !out.includes('"PID" = 0');
    } catch { running = false; }
  }
  return { installed, running, logPath: "/tmp/backpack-connector-daemon.log" };
}
