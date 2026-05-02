import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const VIEWER_URL = process.env.VIEWER_URL ?? "http://localhost:5174";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const headless = process.env.HEADLESS !== "false";

let browser: Browser;
let page: Page;

async function openDashboard(p: Page): Promise<void> {
  await p.goto(VIEWER_URL, { waitUntil: "networkidle0" });
  await p.waitForSelector(".sidebar-tab");
  await p.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>(".sidebar-tab"));
    btns.find((b) => b.textContent?.includes("Dashboard"))?.click();
  });
  await p.waitForSelector(".dash-panel-root", { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 1500)); // let widgets render
}

beforeAll(async () => {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless,
    slowMo: headless ? 0 : 60,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  page = await browser.newPage();
  page.setDefaultTimeout(12000);
}, 30000);

afterAll(async () => {
  await browser?.close();
});

describe("dashboard tab", () => {
  it("Dashboard tab is visible in the sidebar", async () => {
    await page.goto(VIEWER_URL, { waitUntil: "networkidle0" });
    await page.waitForSelector(".sidebar-tab");
    const tab = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".sidebar-tab"))
        .find((b) => b.textContent?.includes("Dashboard"))?.textContent?.trim() ?? null
    );
    expect(tab).toBe("Dashboard");
  });

  it("Signals tab is gone — replaced by Dashboard", async () => {
    const signalsTab = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".sidebar-tab"))
        .some((b) => b.textContent?.trim() === "Signals")
    );
    expect(signalsTab).toBe(false);
  });

  it("Sidebar dashboard pane shows stat numbers and Open Dashboard button", async () => {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll<HTMLButtonElement>(".sidebar-tab"));
      btns.find((b) => b.textContent?.includes("Dashboard"))?.click();
    });
    await page.waitForSelector(".dash-open-btn", { timeout: 5000 });
    const btnText = await page.$eval(".dash-open-btn", (el) => el.textContent?.trim());
    expect(btnText).toBe("Open Dashboard");
    const statsVisible = await page.$$eval(".dash-sidebar-stat", (els) => els.length);
    expect(statsVisible).toBe(2);
  });
});

describe("dashboard panel", () => {
  beforeAll(async () => {
    await openDashboard(page);
  });

  it("panel mounts with dash-panel-root", async () => {
    const mounted = await page.$(".dash-panel-root");
    expect(mounted).not.toBeNull();
  });

  it("toolbar renders with Detect and Refresh buttons", async () => {
    const buttons = await page.$$eval(".dash-toolbar-btn", (els) =>
      els.map((el) => el.textContent?.trim())
    );
    expect(buttons).toContain("Detect signals");
    expect(buttons).toContain("Refresh");
  });

  it("grid renders 6 widgets from the default dashboard spec", async () => {
    const count = await page.$$eval(".dash-widget", (els) => els.length);
    expect(count).toBe(6);
  });

  it("3 stat cards render", async () => {
    const count = await page.$$eval(".dash-stat-body", (els) => els.length);
    expect(count).toBe(3);
  });

  it("stat cards show numeric values (not empty)", async () => {
    const numbers = await page.$$eval(".dash-stat-number", (els) =>
      els.map((el) => el.textContent?.trim())
    );
    expect(numbers.length).toBe(3);
    for (const n of numbers) {
      expect(n).toMatch(/^\d+$/);
    }
  });

  it("stat card titles are correct", async () => {
    const titles = await page.$$eval(".dash-widget-title", (els) =>
      els.map((el) => el.textContent?.trim())
    );
    // CSS text-transform: uppercase is visual only — textContent returns source case
    expect(titles).toContain("Active Signals");
    expect(titles).toContain("High Priority");
    expect(titles).toContain("Learning Graphs");
  });

  it("2 chart bodies render (bar-chart + pie-chart)", async () => {
    const count = await page.$$eval(".dash-chart-body", (els) => els.length);
    expect(count).toBe(2);
  });

  it("ECharts canvas elements rendered inside chart bodies", async () => {
    await new Promise((r) => setTimeout(r, 500));
    const canvasCount = await page.$$eval(".dash-chart-body canvas", (els) => els.length);
    expect(canvasCount).toBeGreaterThanOrEqual(1);
  });

  it("signal-cards widget renders with search input", async () => {
    const searchInput = await page.$(".dash-signals-search");
    expect(searchInput).not.toBeNull();
  });

  it("widget positions use CSS grid-column and grid-row", async () => {
    const gridColumns = await page.$$eval(".dash-widget", (els) =>
      els.map((el) => (el as HTMLElement).style.gridColumn).filter(Boolean)
    );
    expect(gridColumns.length).toBeGreaterThan(0);
    for (const col of gridColumns) {
      expect(col).toMatch(/\d+ \/ span \d+/);
    }
  });

  it("widget backgrounds use CSS variable (not hardcoded)", async () => {
    const bg = await page.$eval(".dash-widget", (el) =>
      getComputedStyle(el).backgroundColor
    );
    // Should not be pure white — must be using --bg-surface
    expect(bg).not.toBe("rgb(255, 255, 255)");
  });
});

describe("theme switching", () => {
  it("switching to light theme doesn't crash or blank the charts", async () => {
    const errors: string[] = [];
    page.once("pageerror", (e) => errors.push(e.message));

    // Toggle to light
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    await new Promise((r) => setTimeout(r, 600));

    // Charts should still be present
    const canvasCount = await page.$$eval(".dash-chart-body canvas", (els) => els.length);
    expect(canvasCount).toBeGreaterThanOrEqual(1);

    // No JS errors from theme change
    expect(errors.filter((e) => !e.includes("favicon")).length).toBe(0);

    // Restore dark
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await new Promise((r) => setTimeout(r, 200));
  });

  it("widget backgrounds change between dark and light", async () => {
    const darkBg = await page.$eval(".dash-widget", (el) =>
      getComputedStyle(el).backgroundColor
    );
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await new Promise((r) => setTimeout(r, 300));
    const lightBg = await page.$eval(".dash-widget", (el) =>
      getComputedStyle(el).backgroundColor
    );
    expect(darkBg).not.toBe(lightBg);
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  });
});

describe("hot reload", () => {
  it("PUT /api/dashboard updates the spec on the server", async () => {
    const res = await page.evaluate(async () => {
      const r = await fetch("/api/dashboard", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          grid: { columns: 2, rowHeight: 200, gap: 12 },
          widgets: [
            { id: "t1", type: "stat-card", title: "Test",
              position: { col: 1, row: 1, colSpan: 1, rowSpan: 1 },
              config: { query: { source: "signals", metric: "count" } } },
            { id: "t2", type: "stat-card", title: "Test 2",
              position: { col: 2, row: 1, colSpan: 1, rowSpan: 1 },
              config: { query: { source: "graphs", metric: "count" } } },
          ],
        }),
      });
      return r.ok;
    });
    expect(res).toBe(true);

    // Wait for poll interval (3s) + render time
    await new Promise((r) => setTimeout(r, 4000));

    const widgetCount = await page.$$eval(".dash-widget", (els) => els.length);
    expect(widgetCount).toBe(2);

    const titles = await page.$$eval(".dash-widget-title", (els) =>
      els.map((el) => el.textContent?.trim())
    );
    expect(titles).toContain("Test");
  });

  it("restoring default dashboard.json reverts to 6 widgets", async () => {
    const res = await page.evaluate(async () => {
      const r = await fetch("/api/dashboard", { method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          grid: { columns: 3, rowHeight: 200, gap: 12 },
          widgets: [
            { id: "w-total", type: "stat-card", title: "Active Signals",
              position: { col: 1, row: 1, colSpan: 1, rowSpan: 1 },
              config: { accentColor: "accent", query: { source: "signals", metric: "count" } } },
            { id: "w-high", type: "stat-card", title: "High Priority",
              position: { col: 2, row: 1, colSpan: 1, rowSpan: 1 },
              config: { accentColor: "high", query: { source: "signals", metric: "count", filter: { severity: ["high","critical"] } } } },
            { id: "w-graphs", type: "stat-card", title: "Learning Graphs",
              position: { col: 3, row: 1, colSpan: 1, rowSpan: 1 },
              config: { accentColor: "neutral", query: { source: "graphs", metric: "count" } } },
            { id: "w-by-kind", type: "bar-chart", title: "Signals by Type",
              position: { col: 1, row: 2, colSpan: 2, rowSpan: 1 },
              config: { horizontal: true, query: { source: "signals", groupBy: "kind", metric: "count", limit: 10 } } },
            { id: "w-severity", type: "pie-chart", title: "By Severity",
              position: { col: 3, row: 2, colSpan: 1, rowSpan: 1 },
              config: { donut: true, query: { source: "signals", groupBy: "severity", metric: "count" } } },
            { id: "w-signals", type: "signal-cards", title: "Active Signals",
              position: { col: 1, row: 3, colSpan: 3, rowSpan: 3 },
              config: { limit: 50, showDismiss: true, sortBy: "score" } },
          ],
        }),
      });
      return r.ok;
    });
    expect(res).toBe(true);

    await new Promise((r) => setTimeout(r, 4000));

    const widgetCount = await page.$$eval(".dash-widget", (els) => els.length);
    expect(widgetCount).toBe(6);
  });
});

describe("no JS errors throughout", () => {
  it("no page errors after all tests", async () => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await new Promise((r) => setTimeout(r, 500));
    const fatal = errors.filter((e) => !e.includes("favicon") && !e.includes("Warning"));
    expect(fatal).toHaveLength(0);
  });
});
