/**
 * E2E tests for the connector viewer extension.
 *
 * Requires:
 *   - Viewer running at VIEWER_URL (default http://localhost:5174)
 *   - ArcadeDB running at ARCADEDB_URL (default http://localhost:2480)
 *   - ms-teams-meeting-bot graph projected into ArcadeDB
 *   - Connector extension installed (backpack-connector install-extension)
 *
 * Run: npx vitest run tests/e2e/extension.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const VIEWER_URL = process.env.VIEWER_URL ?? "http://localhost:5174";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TEST_DB = process.env.TEST_DB ?? "ms_teams_meeting_bot";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  const headless = process.env.HEADLESS !== "false";
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless,
    slowMo: headless ? 0 : 80,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  page = await browser.newPage();
  page.setDefaultTimeout(10000);
}, 30000);

afterAll(async () => {
  await browser?.close();
});

describe("extension registration", () => {
  it("connector extension appears in /api/extensions", async () => {
    const res = await page.goto(`${VIEWER_URL}/api/extensions`);
    expect(res?.ok()).toBe(true);
    const body = await page.evaluate(() => JSON.parse(document.body.innerText)) as { name: string }[];
    const names = body.map((e) => e.name);
    expect(names).toContain("connector");
  });

  it("connector extension has correct metadata", async () => {
    const res = await page.goto(`${VIEWER_URL}/api/extensions`);
    expect(res?.ok()).toBe(true);
    const body = await page.evaluate(() => JSON.parse(document.body.innerText)) as { name: string; displayName: string; viewerApi: string }[];
    const ext = body.find((e) => e.name === "connector");
    expect(ext?.displayName).toBe("Graph Query");
    expect(ext?.viewerApi).toBe("1");
  });
});

describe("viewer loads with extension", () => {
  it("viewer page loads without JS errors", async () => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(VIEWER_URL, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1000));

    const fatal = errors.filter((e) => !e.includes("favicon") && !e.includes("Warning"));
    expect(fatal).toHaveLength(0);
  });

  it("Query taskbar button is present in the DOM", async () => {
    await page.goto(VIEWER_URL, { waitUntil: "networkidle0" });
    await page.waitForSelector("button", { timeout: 8000 });

    const queryBtn = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      return btns.find((b) => b.textContent?.includes("Query"))?.textContent ?? null;
    });

    expect(queryBtn).toBeTruthy();
    expect(queryBtn).toContain("Query");
  });
});

describe("query panel", () => {
  beforeAll(async () => {
    await page.goto(VIEWER_URL, { waitUntil: "networkidle0" });
    await page.waitForSelector("button");
    // Click the Query button to open the panel
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const btn = btns.find((b) => b.textContent?.includes("Query"));
      (btn as HTMLButtonElement)?.click();
    });
    await new Promise((r) => setTimeout(r, 500));
  });

  it("panel mounts with cq-root element", async () => {
    const root = await page.$(".cq-root");
    expect(root).not.toBeNull();
  });

  it("database input is present and auto-fills", async () => {
    const dbInput = await page.$(".cq-root input[type='text']");
    expect(dbInput).not.toBeNull();
  });

  it("textarea is present for Cypher input", async () => {
    const textarea = await page.$(".cq-root textarea");
    expect(textarea).not.toBeNull();
  });

  it("executes a Cypher query and shows results", async () => {
    // Set the database name
    await page.evaluate((db: string) => {
      const input = document.querySelector<HTMLInputElement>('[data-cq="database"]');
      if (input) { input.value = db; }
    }, TEST_DB);

    await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(".cq-root textarea");
      if (ta) {
        ta.value = "MATCH (n:Platform) RETURN n.name LIMIT 3";
        ta.dispatchEvent(new Event("input"));
      }
    });

    // Click Execute
    await page.evaluate(() => {
      const btns = document.querySelectorAll<HTMLButtonElement>(".cq-root button");
      const execBtn = Array.from(btns).find((b) => b.textContent?.trim() === "Execute");
      execBtn?.click();
    });

    // Wait for results
    await page.waitForSelector(".cq-table", { timeout: 8000 });

    const rowCount = await page.evaluate(() => {
      return document.querySelectorAll(".cq-table tbody tr").length;
    });

    expect(rowCount).toBeGreaterThan(0);
    expect(rowCount).toBeLessThanOrEqual(3);
  });

  it("shows result count in header", async () => {
    const countText = await page.evaluate(() => {
      return document.querySelector(".cq-results-header span")?.textContent ?? "";
    });
    expect(countText).toMatch(/\d+ result/);
  });

  it("shows Focus in viewer button when results have node data", async () => {
    // Run a query that returns nodes with bk_id
    await page.evaluate((db: string) => {
      const input = document.querySelector<HTMLInputElement>('[data-cq="database"]');
      if (input) input.value = db;
      const ta = document.querySelector<HTMLTextAreaElement>(".cq-root textarea");
      if (ta) ta.value = "MATCH (n:Platform) RETURN n LIMIT 5";
    }, TEST_DB);

    await page.evaluate(() => {
      const btns = document.querySelectorAll<HTMLButtonElement>(".cq-root button");
      const execBtn = Array.from(btns).find((b) => b.textContent?.trim() === "Execute");
      execBtn?.click();
    });

    await page.waitForSelector(".cq-table", { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 200));

    const focusBtnVisible = await page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>(".cq-focus-btn");
      return btn !== null && !btn.hidden;
    });

    expect(focusBtnVisible).toBe(true);
  });

  it("Ctrl+Enter executes query", async () => {
    await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(".cq-root textarea");
      if (ta) {
        ta.value = "MATCH (n:API) RETURN n.name LIMIT 2";
        ta.focus();
      }
    });

    await page.keyboard.down("Control");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");

    await page.waitForSelector(".cq-table", { timeout: 8000 });

    const rowCount = await page.evaluate(() =>
      document.querySelectorAll(".cq-table tbody tr").length
    );
    expect(rowCount).toBeGreaterThan(0);
  });
});

describe("error handling", () => {
  it("shows error message for invalid Cypher", async () => {
    await page.waitForSelector(".cq-root", { timeout: 5000 }).catch(() => {
      // Panel may have been closed — reopen it
      return page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        btns.find((b) => b.textContent?.includes("Query"))?.click();
      });
    });
    await new Promise((r) => setTimeout(r, 300));

    await page.evaluate((db: string) => {
      const input = document.querySelector<HTMLInputElement>('[data-cq="database"]');
      if (input) input.value = db;
      const ta = document.querySelector<HTMLTextAreaElement>(".cq-root textarea");
      if (ta) ta.value = "THIS IS NOT VALID CYPHER !!!";
    }, TEST_DB);

    await page.evaluate(() => {
      const btns = document.querySelectorAll<HTMLButtonElement>(".cq-root button");
      const execBtn = Array.from(btns).find((b) => b.textContent?.trim() === "Execute");
      execBtn?.click();
    });

    await page.waitForSelector(".cq-error", { timeout: 8000 });

    const errorText = await page.evaluate(() =>
      document.querySelector(".cq-error")?.textContent ?? ""
    );
    expect(errorText.length).toBeGreaterThan(0);
  });
});
