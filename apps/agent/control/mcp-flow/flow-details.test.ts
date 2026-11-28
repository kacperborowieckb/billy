import { describe, expect, it } from "vitest";

import { detailsShowTheCall } from "./flow-details.ts";

const call = {
  connection: "notion",
  tool: "notion-create-pages",
  arguments: {
    parent: { page_id: "page-1" },
    pages: [{ properties: { title: "Dune" }, content: "Notes about Dune" }],
  },
};

describe("the check of the Details file", () => {
  it("passes only a file that holds the full arguments of the call", () => {
    const partial = {
      ...call,
      arguments: { pages: [{ content: "Notes about Dune" }] },
    };

    expect(detailsShowTheCall(JSON.stringify(call, null, 2), call)).toBe(true);
    expect(detailsShowTheCall(JSON.stringify(partial), call)).toBe(false);
    expect(detailsShowTheCall("Notes about Dune", call)).toBe(false);
  });
});
