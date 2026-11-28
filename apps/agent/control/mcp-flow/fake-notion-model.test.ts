import { describe, expect, it } from "vitest";

import { isFakeNotionMessage } from "./fake-notion-model.ts";

describe("the fake Notion model", () => {
  it("takes its own commands and no inherited name", () => {
    expect(isFakeNotionMessage("notion connect")).toBe(true);
    expect(isFakeNotionMessage("notion __proto__")).toBe(false);
    expect(isFakeNotionMessage("notion constructor")).toBe(false);
  });
});
