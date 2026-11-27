import { describe, expect, it } from "vitest";

import { failureReasonOf } from "../src/mcp/mcp-failure.ts";

describe("the reason of an MCP failure", () => {
  it("names a known SQL limit that sits deep in the cause chain", () => {
    const driver = new Error("too many SQL variables at offset 421");
    const failed = new Error("Failed query", {
      cause: { reasons: [{ defect: { reason: { cause: driver } } }] },
    });

    expect(failureReasonOf(failed)).toBe("sql_too_many_parameters");
  });

  it("names a hub that has no name", () => {
    const refused = new Error(
      "McpHub could not determine its Durable Object name. Address it with idFromName() or getByName()."
    );

    expect(failureReasonOf(refused)).toBe("durable_object_has_no_name");
  });

  it("ends on a cause chain that points to itself", () => {
    const looped = new TypeError("loop");
    looped.cause = looped;
    const late = Object.assign(new Error("outer"), {
      cause: Object.assign(new Error("inner"), { name: "TimeoutError" }),
    });

    expect(failureReasonOf(looped)).toContain("TypeError");
    expect(failureReasonOf(late)).toBe("deadline");
  });

  it("holds only class names, never a message or a value", () => {
    const inner = new TypeError("Pat Reader fake-access-token-4b9d");
    const failed = Object.assign(
      new Error("secret page text", { cause: inner }),
      { name: "Page content with spaces" }
    );

    expect(failureReasonOf(failed)).toBe("TypeError");
    expect(failureReasonOf("fake-access-token-4b9d")).toBe("unknown");
  });
});
