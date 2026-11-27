import { describe, expect, it, vi } from "vitest";

import { KeyedQueue } from "../src/mcp/keyed-queue.ts";
import {
  authorizedFetch,
  isInsufficientScope,
} from "../src/mcp/mcp-authorized-fetch.ts";
import { McpCallGateway } from "../src/mcp/mcp-call-gateway.ts";
import type { McpConnectionHealth } from "../src/mcp/mcp-connection-health.ts";
import type { McpConnectionLedger } from "../src/mcp/mcp-connection-ledger.ts";
import { McpRefreshUnavailableError } from "../src/mcp/mcp-refresh-unavailable-error.ts";
import { McpToolCopySync } from "../src/mcp/mcp-tool-copy-sync.ts";
import type { McpToolCopy } from "../src/mcp/mcp-tool-copy.ts";

const challenged = (status: number, challenge: string) =>
  new Response(null, { status, headers: { "WWW-Authenticate": challenge } });

describe("the Bearer challenge parser", () => {
  it.each([
    'Bearer error="insufficient_scope", scope="write"',
    'Bearer error = "insufficient_scope"',
    "Bearer error=insufficient_scope",
    'Bearer realm="x",ERROR="insufficient_scope"',
  ])("accepts %s", (challenge) => {
    expect(isInsufficientScope(challenged(403, challenge))).toBe(true);
  });

  it.each([
    'Bearer realm="error=insufficient_scope"',
    'Bearer error="invalid_token"',
    'Bearer error="insufficient_scope_extra"',
  ])("ignores %s", (challenge) => {
    expect(isInsufficientScope(challenged(403, challenge))).toBe(false);
  });

  it("ignores a status other than 403", () => {
    expect(
      isInsufficientScope(challenged(401, 'Bearer error="insufficient_scope"'))
    ).toBe(false);
  });
});

describe("the queue flag of the authorized fetch", () => {
  it("is read again at a refusal, so a request that a joined connect now waits for does not wait for the queue", async () => {
    let queueWaits = false;
    const recover = vi.fn();
    const health = {
      accessTokenFor: () => {
        queueWaits = true;
        return Promise.resolve({ _tag: "Token", accessToken: "t1" });
      },
      recoverFromRejection: recover,
    } as unknown as McpConnectionHealth;
    const fetchWithRecovery = authorizedFetch({
      send: () => Promise.resolve(new Response(null, { status: 401 })),
      entry: { catalogId: "c" } as never,
      ownerId: "owner",
      health,
      queueWaitsOnConnect: () => queueWaits,
    });

    await expect(
      fetchWithRecovery("https://mcp.test.example/mcp", { method: "POST" })
    ).rejects.toBeInstanceOf(McpRefreshUnavailableError);
    expect(recover).not.toHaveBeenCalled();
  });
});

describe("the sign-in notification of a call", () => {
  it("does not reach the Personal Agent after a reconnect that finished in between", async () => {
    let state: "ready" | "needs_sign_in" = "needs_sign_in";
    const ledger = {
      stateOf: () => Promise.resolve(state),
      lastErrorOf: () => Promise.resolve(undefined),
    } as unknown as McpConnectionLedger;
    const entryQueue = new KeyedQueue();
    const tell = vi.fn(() => Promise.resolve());
    const gateway = new McpCallGateway({
      catalog: [{ catalogId: "c" }] as never,
      entryQueue,
      ledger,
      connector: { epochOf: () => 0 } as never,
      ownerId: () => "owner",
      tellNeedsSignIn: tell,
    });
    const reconnecting = Promise.withResolvers<undefined>();
    const reconnect = entryQueue.run("c", async () => {
      await reconnecting.promise;
      state = "ready";
    });

    const call = gateway.callTool({
      catalogId: "c",
      tool: "search",
      arguments: {},
      connectTimeoutMillis: 1,
      callTimeoutMillis: 1,
    });
    await vi.waitFor(() => expect(entryQueue.waitingCount("c")).toBe(1));
    reconnecting.resolve(undefined);
    await reconnect;

    expect(await call).toEqual({ _tag: "Failed", reason: "failed" });
    expect(tell).not.toHaveBeenCalled();
  });
});

const copy = (name: string): McpToolCopy => ({
  name,
  description: "",
  inputSchema: {},
  annotations: {},
});

const readyLedger = (isReady: () => boolean) =>
  ({
    isReady: () => Promise.resolve(isReady()),
  }) as unknown as McpConnectionLedger;

describe("the tool catalog sync of a Connection that is removed", () => {
  it("delivers no copy and closes the connection that a refresh opened during the removal", async () => {
    let ready = true;
    const delivered: string[] = [];
    const closed: string[] = [];
    const sync = new McpToolCopySync({
      catalog: [{ catalogId: "c" }] as never,
      entryQueue: new KeyedQueue(),
      ledger: readyLedger(() => ready),
      epochOf: () => 0,
      isLive: () => true,
      copiesOf: () => [copy("a")],
      refreshTools: () => {
        ready = false;
        return Promise.resolve("refreshed");
      },
      closeLive: (catalogId) => {
        closed.push(catalogId);
        return Promise.resolve();
      },
      deliver: (catalogId) => {
        delivered.push(catalogId);
        return Promise.resolve();
      },
    });

    expect(await sync.refresh("c", "owner", 1)).toEqual({
      outcome: "not_ready",
    });
    expect(delivered).toEqual([]);
    expect(closed).toEqual(["c"]);
  });
});

describe("the copy marker of the tool catalog sync", () => {
  it("records the copy that was delivered, so a change during the delivery is sent next", async () => {
    let current = [copy("a")];
    const delivered: string[][] = [];
    const firstDelivery = Promise.withResolvers<undefined>();
    const sync = new McpToolCopySync({
      catalog: [],
      entryQueue: new KeyedQueue(),
      ledger: readyLedger(() => true),
      epochOf: () => 0,
      isLive: () => true,
      copiesOf: () => current,
      refreshTools: () => Promise.resolve("refreshed"),
      closeLive: () => Promise.resolve(),
      deliver: async (_catalogId, copies) => {
        delivered.push(copies.map(({ name }) => name));
        if (delivered.length === 1) {
          await firstDelivery.promise;
        }
      },
    });

    const sending = sync.sendWhenChanged("c", 0);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    current = [copy("b")];
    firstDelivery.resolve(undefined);
    await sending;
    await sync.sendWhenChanged("c", 0);

    expect(delivered).toEqual([["a"], ["b"]]);
  });
});
