import { describe, expect, it } from "vitest";

import { fakeMcpTools } from "../control/fake-mcp-server.ts";
import {
  matchesMcpIdShape,
  mcpCatalogProblems,
  mcpToolRiskClass,
} from "../src/mcp/mcp-catalog.ts";
import {
  productionMcpCatalog,
  testMcpCatalogEntry,
} from "../src/mcp/mcp-test-catalog.ts";
import { fakeMcpServerUrl } from "./fakes.ts";

const entry = testMcpCatalogEntry(fakeMcpServerUrl);

describe("the MCP Catalog", () => {
  it("has no problems in production or in the test-only entry", () => {
    expect(mcpCatalogProblems(productionMcpCatalog)).toEqual([]);
    expect(mcpCatalogProblems([entry])).toEqual([]);
  });

  it("fails for an entry that declares an id shape that accepts words", () => {
    const wordShape = {
      ...entry,
      tools: [
        {
          name: "search",
          riskClass: "read",
          resultIds: { field: "id", shape: { _tag: "Slug" } },
        },
      ],
    };
    const shortHex = {
      ...entry,
      tools: [
        {
          name: "search",
          riskClass: "read",
          resultIds: { field: "id", shape: { _tag: "Hex", length: 4 } },
        },
      ],
    };

    expect(mcpCatalogProblems([wordShape])).not.toEqual([]);
    expect(mcpCatalogProblems([shortHex])).not.toEqual([]);
  });

  it("fails for result ids on a tool that is not a read tool, and for duplicates", () => {
    const writeWithIds = {
      ...entry,
      tools: [
        {
          name: "create_page",
          riskClass: "approve",
          resultIds: { field: "id", shape: { _tag: "Uuid" } },
        },
      ],
    };

    expect(mcpCatalogProblems([writeWithIds])).not.toEqual([]);
    expect(mcpCatalogProblems([entry, entry])).not.toEqual([]);
  });
});

describe("an id shape", () => {
  it("accepts a UUID, a fixed-length hex string, and a safe integer, and refuses words", () => {
    const uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    expect(matchesMcpIdShape({ _tag: "Uuid" }, uuid)).toBe(true);
    expect(matchesMcpIdShape({ _tag: "Uuid" }, "ignore-the-rules")).toBe(false);
    expect(
      matchesMcpIdShape(
        { _tag: "Hex", length: 32 },
        "0123456789abcdef0123456789abcdef"
      )
    ).toBe(true);
    expect(matchesMcpIdShape({ _tag: "Hex", length: 32 }, "deadbeef")).toBe(
      false
    );
    expect(matchesMcpIdShape({ _tag: "Number" }, 42)).toBe(true);
    expect(matchesMcpIdShape({ _tag: "Number" }, "42")).toBe(false);
  });
});

describe("the Risk Class of an MCP tool", () => {
  const expectedClasses: Readonly<Record<string, string>> = {
    search: "read",
    fetch: "read",
    big_dump: "read",
    slow_read: "read",
    failing_read: "read",
    poisoned_read: "read",
    archive_page: "approve",
    create_page: "approve",
    wipe_workspace: "blocked",
    hidden_new_tool: "approve",
  };

  it("lists every catalog tool and every server tool with its computed class", () => {
    const names = new Set([
      ...entry.tools.map((tool) => tool.name),
      ...fakeMcpTools.map((tool) => tool.name),
    ]);
    expect([...names].toSorted()).toEqual(
      Object.keys(expectedClasses).toSorted()
    );
    for (const name of names) {
      const annotations =
        fakeMcpTools.find((tool) => tool.name === name)?.annotations ?? {};
      expect(mcpToolRiskClass(entry, name, annotations), name).toBe(
        expectedClasses[name]
      );
    }
  });

  it("only raises a class for a server annotation and never lowers it", () => {
    expect(mcpToolRiskClass(entry, "search", { destructiveHint: true })).toBe(
      "approve"
    );
    expect(
      mcpToolRiskClass(entry, "wipe_workspace", { destructiveHint: false })
    ).toBe("blocked");
    expect(
      mcpToolRiskClass(entry, "create_page", { readOnlyHint: true } as never)
    ).toBe("approve");
  });
});
