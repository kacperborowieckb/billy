import { describe, expect, it } from "vitest";

import { withHiddenCharactersShown } from "./mcp-fingerprints.ts";

describe("the printed tool definitions", () => {
  it("shows the characters that a terminal would hide and keeps the JSON value", () => {
    const [tag, csi, override, lineEnd] = [
      0xe_00_41, 0x9b, 0x20_2e, 0x20_28,
    ].map((code) => String.fromCodePoint(code));
    const description = `Search${tag} pages${csi}2J${override}evil${lineEnd}`;

    const printed = withHiddenCharactersShown(
      JSON.stringify({ description }, null, 2)
    );

    expect(printed).toContain("\\udb40\\udc41");
    expect(printed).toContain("\\u009b2J\\u202eevil\\u2028");
    expect(JSON.parse(printed)).toEqual({ description });
  });
});
