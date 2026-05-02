import { describe, it, expect } from "vitest";
import { sanitizeDatabaseName } from "../../src/database-name.js";

describe("sanitizeDatabaseName", () => {
  it("passes clean names through lowercased", () => {
    expect(sanitizeDatabaseName("myGraph")).toBe("mygraph");
  });

  it("replaces hyphens with underscores", () => {
    expect(sanitizeDatabaseName("ms-teams-meeting-bot")).toBe("ms_teams_meeting_bot");
  });

  it("replaces spaces with underscores", () => {
    expect(sanitizeDatabaseName("my graph name")).toBe("my_graph_name");
  });

  it("prepends underscore when name starts with digit", () => {
    expect(sanitizeDatabaseName("2024-research")).toBe("_2024_research");
  });

  it("lowercases everything", () => {
    expect(sanitizeDatabaseName("AzureOpenAI")).toBe("azureopenai");
  });
});
