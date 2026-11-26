import { describe, expect, it, vi } from "vitest";

import {
  guardedFetch,
  refusedReasonOf,
} from "../src/mcp/mcp-outbound-guard.ts";

const refused = (url: string, allowed: readonly string[] = []) =>
  refusedReasonOf(new URL(url), allowed) !== undefined;

describe("the outbound guard of the MCP Hub", () => {
  it.each([
    "http://mcp.example.com/mcp",
    "https://localhost/mcp",
    "https://127.0.0.1/mcp",
    "https://10.1.2.3/mcp",
    "https://172.16.0.1/mcp",
    "https://192.168.1.1/mcp",
    "https://169.254.169.254/latest",
    "https://100.64.0.1/mcp",
    "https://[::1]/mcp",
    "https://[fe80::1]/mcp",
    "https://[fd00::1]/mcp",
    "https://[::ffff:10.0.0.1]/mcp",
    "https://metadata.internal/mcp",
    "https://printer.local/mcp",
    "https://intranet/mcp",
    "https://2130706433/mcp",
  ])("refuses %s", (url) => {
    expect(refused(url)).toBe(true);
  });

  it.each([
    "https://mcp.notion.com/mcp",
    "https://8.8.8.8/mcp",
    "https://[2606:4700::1111]/mcp",
  ])("allows %s", (url) => {
    expect(refused(url)).toBe(false);
  });

  it("allows only the exact origin that the Operator named", () => {
    expect(
      refused("http://127.0.0.1:9000/mcp", ["http://127.0.0.1:9000"])
    ).toBe(false);
    expect(
      refused("http://127.0.0.1:9001/mcp", ["http://127.0.0.1:9000"])
    ).toBe(true);
  });

  it("sends no request to a refused address and refuses a redirect", async () => {
    const send = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 302 }))
    );
    const guarded = guardedFetch(send, []);

    await expect(guarded("https://10.0.0.1/mcp")).rejects.toThrow("refused");
    expect(send).not.toHaveBeenCalled();
    await expect(guarded("https://mcp.example.com/mcp")).rejects.toThrow(
      "redirect"
    );
  });
});
