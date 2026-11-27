import { describe, expect, it, vi } from "vitest";

import { McpServerConnector } from "../src/mcp/mcp-server-connector.ts";
import { revokeTokens } from "../src/mcp/oauth-token-revocation.ts";

interface FakeConnection {
  connectionState: "ready";
  close: () => Promise<void>;
}

interface FakeBehavior {
  readonly closeOf?: (id: string) => Promise<void>;
  readonly connectOf?: (id: string) => Promise<void>;
  readonly callOf?: (id: string) => Promise<void>;
  readonly discoverOf?: (id: string) => Promise<void>;
}

const fakeSdkManager = ({
  closeOf,
  connectOf,
  callOf,
  discoverOf,
}: FakeBehavior = {}) => {
  const mcpConnections: Record<string, FakeConnection> = {};
  const rows = new Set<string>();
  const registered: string[] = [];
  const removed: string[] = [];
  const calledIds: string[] = [];
  const closeAttempts: string[] = [];
  const closeConnection = async (id: string) => {
    closeAttempts.push(id);
    const connection = mcpConnections[id];
    if (connection === undefined) {
      throw new Error("no such connection");
    }
    try {
      await connection.close();
    } finally {
      Reflect.deleteProperty(mcpConnections, id);
    }
  };
  const manager = {
    mcpConnections,
    registerServer: (id: string) => {
      registered.push(id);
      rows.add(id);
      mcpConnections[id] = {
        connectionState: "ready",
        close: () => closeOf?.(id) ?? Promise.resolve(),
      };
      return Promise.resolve(id);
    },
    connectToServer: async (id: string) => {
      await connectOf?.(id);
      return { state: "connected" };
    },
    discoverIfConnected: async (id: string) => {
      await discoverOf?.(id);
      return { success: true };
    },
    listTools: () => [],
    callTool: async ({ serverId }: { serverId: string }) => {
      calledIds.push(serverId);
      await callOf?.(serverId);
      return { content: [], isError: false };
    },
    closeConnection,
    removeServer: async (id: string) => {
      removed.push(id);
      if (mcpConnections[id] !== undefined) {
        try {
          await closeConnection(id);
        } catch {
          rows.delete(id);
        }
      }
      rows.delete(id);
    },
  };
  return { manager, rows, registered, removed, closeAttempts, calledIds };
};

const hangUntil = (release: Promise<undefined>) => () =>
  release as Promise<void>;

const storageStub = (initial: Record<string, unknown> = {}) => {
  const stored = new Map(Object.entries(initial));
  return {
    get: (key: string) => Promise.resolve(stored.get(key)),
    put: (key: string, value: unknown) => {
      stored.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(stored.delete(key)),
    stored,
  } as unknown as DurableObjectStorage & {
    stored: Map<string, unknown>;
  };
};

const connectorOver = (
  manager: unknown,
  storage: DurableObjectStorage = storageStub(),
  credentials: () => Promise<never> = () => Promise.resolve({} as never)
) =>
  new McpServerConnector({
    manager: manager as never,
    storage,
    start: () => Promise.resolve(),
    send: () => Promise.resolve(new Response(null, { status: 500 })),
    allowedOrigins: [],
    credentials,
    health: {} as never,
  });

const entry = { catalogId: "c", serverUrl: "https://mcp.test.example/mcp" };

const request = {
  catalogId: "c",
  tool: "search",
  arguments: {},
  connectTimeoutMillis: 1000,
  callTimeoutMillis: 1000,
};

const callOf = (connector: McpServerConnector, epoch: number) =>
  connector.callTool(entry as never, "owner", { request, epoch });

describe("the revocation of a token", () => {
  it("answers failed, not an error, when the client secret cannot be encoded", async () => {
    const outcome = await revokeTokens({
      send: () => Promise.resolve(new Response(null, { status: 200 })),
      client: { client_id: "c", client_secret: "\uD800", redirectUrl: "r" },
      revocationEndpoint: "https://mcp.test.example/revoke",
      tokens: { access_token: "a", token_type: "Bearer" },
    });

    expect(outcome).toBe("failed");
  });
});

describe("the connector of a Connection that is removed", () => {
  it("does not open a connection for a call that was admitted before the removal", async () => {
    const { manager, registered } = fakeSdkManager();
    const connector = connectorOver(manager);
    const epoch = connector.epochOf("c");

    await connector.forget("c", 50);
    const outcome = await callOf(connector, epoch);

    expect(outcome).toEqual({ _tag: "Failed", reason: "not_connected" });
    expect(registered).toEqual([]);
  });

  it("does not use a ready connection for a call that was admitted before the removal", async () => {
    const { manager, registered } = fakeSdkManager();
    const connector = connectorOver(manager);
    const first = await callOf(connector, connector.epochOf("c"));
    const admitted = connector.epochOf("c");

    await connector.forget("c", 50);
    await callOf(connector, connector.epochOf("c"));
    const stale = await callOf(connector, admitted);

    expect(first._tag).toBe("Result");
    expect(stale).toEqual({ _tag: "Failed", reason: "not_connected" });
    expect(registered).toEqual(["c:0", "c:1"]);
  });

  it("does not register a server when the Connection was removed while its credentials were read", async () => {
    const { manager, registered } = fakeSdkManager();
    const credentialsRead = Promise.withResolvers<undefined>();
    const connector = connectorOver(manager, storageStub(), async () => {
      await credentialsRead.promise;
      return {} as never;
    });
    const epoch = connector.epochOf("c");

    const calling = callOf(connector, epoch);
    await connector.forget("c", 50);
    credentialsRead.resolve(undefined);

    expect(await calling).toEqual({ _tag: "Failed", reason: "failed" });
    expect(registered).toEqual([]);
  });
});

describe("one owner for each SDK operation", () => {
  it("returns at the deadline of a close that hangs, keeps its record inert, and removes it when the close ends", async () => {
    const release = Promise.withResolvers<undefined>();
    const { manager, rows, removed } = fakeSdkManager({
      closeOf: hangUntil(release.promise),
    });
    const storage = storageStub();
    const connector = connectorOver(manager, storage);

    await callOf(connector, connector.epochOf("c"));
    await connector.forget("c", 20);
    await callOf(connector, connector.epochOf("c"));
    await connector.forget("c", 20);

    expect(removed).toEqual(expect.arrayContaining(["c:0", "c:1"]));
    expect(rows).toEqual(new Set(["c:0", "c:1"]));
    release.resolve(undefined);
    await vi.waitFor(() => expect(rows.size).toBe(0));
    await vi.waitFor(() =>
      expect(storage.stored.get("sdk-servers:c")).toBeUndefined()
    );
  });

  it("lets a reconnect register under a new SDK id after a hung close, and the late settle leaves the new connection registered", async () => {
    const release = Promise.withResolvers<undefined>();
    const { manager, registered, rows } = fakeSdkManager({
      closeOf: (id) =>
        id === "c:0" ? (release.promise as Promise<void>) : Promise.resolve(),
    });
    const storage = storageStub();
    const connector = connectorOver(manager, storage);
    await callOf(connector, connector.epochOf("c"));

    await connector.forget("c", 20);
    const reconnected = await callOf(connector, connector.epochOf("c"));
    release.resolve(undefined);
    await vi.waitFor(() => expect(rows).toEqual(new Set(["c:1"])));
    const afterLateSettle = await callOf(connector, connector.epochOf("c"));

    expect(reconnected._tag).toBe("Result");
    expect(afterLateSettle._tag).toBe("Result");
    expect(Object.keys(manager.mcpConnections)).toEqual(["c:1"]);
    expect(registered).toEqual(["c:0", "c:1"]);
    expect(storage.stored.get("sdk-servers:c")).toEqual(["c:1"]);
  });

  it("retires a connect that passes its deadline, so a reconnect registers its own id and the late settle of the old connect does not fail it", async () => {
    const release = Promise.withResolvers<undefined>();
    const { manager, registered, rows } = fakeSdkManager({
      connectOf: (id) =>
        id === "c:0" ? (release.promise as Promise<void>) : Promise.resolve(),
    });
    const connector = connectorOver(manager);
    const short = { ...request, connectTimeoutMillis: 20 };

    const timedOut = await connector.callTool(entry as never, "owner", {
      request: short,
      epoch: connector.epochOf("c"),
    });
    const reconnected = await callOf(connector, connector.epochOf("c"));
    release.resolve(undefined);
    await vi.waitFor(() => expect(rows).toEqual(new Set(["c:1"])));
    const afterLateSettle = await callOf(connector, connector.epochOf("c"));

    expect(timedOut).toEqual({ _tag: "Failed", reason: "timed_out" });
    expect(reconnected._tag).toBe("Result");
    expect(afterLateSettle._tag).toBe("Result");
    expect(registered).toEqual(["c:0", "c:1"]);
    expect(Object.keys(manager.mcpConnections)).toEqual(["c:1"]);
  });

  it("lets a late failure of a retired connect fail only itself", async () => {
    const release = Promise.withResolvers<undefined>();
    const { manager } = fakeSdkManager({
      connectOf: (id) =>
        id === "c:0"
          ? (release.promise.then(() => {
              throw new Error("late failure");
            }) as Promise<void>)
          : Promise.resolve(),
    });
    const connector = connectorOver(manager);
    await connector.callTool(entry as never, "owner", {
      request: { ...request, connectTimeoutMillis: 20 },
      epoch: connector.epochOf("c"),
    });
    const reconnected = await callOf(connector, connector.epochOf("c"));

    release.resolve(undefined);
    const afterLateFailure = await callOf(connector, connector.epochOf("c"));

    expect(reconnected._tag).toBe("Result");
    expect(afterLateFailure._tag).toBe("Result");
  });

  it("retires the id of a connect that passes its deadline with no later connect", async () => {
    const release = Promise.withResolvers<undefined>();
    const { manager, rows } = fakeSdkManager({
      connectOf: hangUntil(release.promise),
    });
    const connector = connectorOver(manager);

    await connector.callTool(entry as never, "owner", {
      request: { ...request, connectTimeoutMillis: 20 },
      epoch: connector.epochOf("c"),
    });

    expect(connector.epochOf("c")).toBe(1);
    release.resolve(undefined);
    await vi.waitFor(() => expect(rows.size).toBe(0));
  });

  it("leaves no connection and no record when a disconnect follows a connect timeout with no reconnect", async () => {
    const release = Promise.withResolvers<undefined>();
    const { manager, rows, closeAttempts } = fakeSdkManager({
      connectOf: hangUntil(release.promise),
    });
    const connector = connectorOver(manager);
    await connector.callTool(entry as never, "owner", {
      request: { ...request, connectTimeoutMillis: 20 },
      epoch: connector.epochOf("c"),
    });

    await connector.forget("c", 20);

    expect(closeAttempts).toContain("c:0");
    await vi.waitFor(() => expect(rows.size).toBe(0));
    expect(Object.keys(manager.mcpConnections)).toEqual([]);
    release.resolve(undefined);
  });

  it("retires the id of a call that passes its deadline, so the next call uses a new id", async () => {
    const release = Promise.withResolvers<undefined>();
    const { manager, calledIds, registered } = fakeSdkManager({
      callOf: (id) =>
        id === "c:0" ? (release.promise as Promise<void>) : Promise.resolve(),
    });
    const connector = connectorOver(manager);

    const timedOut = await connector.callTool(entry as never, "owner", {
      request: { ...request, callTimeoutMillis: 20 },
      epoch: connector.epochOf("c"),
    });
    const next = await callOf(connector, connector.epochOf("c"));
    release.resolve(undefined);

    expect(timedOut).toEqual({ _tag: "Failed", reason: "timed_out" });
    expect(next._tag).toBe("Result");
    expect(calledIds).toEqual(["c:0", "c:1"]);
    expect(registered).toEqual(["c:0", "c:1"]);
  });

  it("keeps the id when a call throws an error that is no deadline", async () => {
    const { manager, calledIds } = fakeSdkManager({
      callOf: (id) =>
        id === "c:0" ? Promise.reject(new Error("sign-in")) : Promise.resolve(),
    });
    const connector = connectorOver(manager);

    await callOf(connector, connector.epochOf("c"));
    await callOf(connector, connector.epochOf("c"));

    expect(calledIds).toEqual(["c:0", "c:0"]);
  });

  it("retires the id when a call throws an SDK timeout", async () => {
    const { manager, calledIds } = fakeSdkManager({
      callOf: (id) =>
        id === "c:0"
          ? Promise.reject(
              Object.assign(new Error("timed out"), { code: -32_001 })
            )
          : Promise.resolve(),
    });
    const connector = connectorOver(manager);

    const failed = await callOf(connector, connector.epochOf("c"));
    const next = await callOf(connector, connector.epochOf("c"));

    expect(failed).toEqual({ _tag: "Failed", reason: "failed" });
    expect(next._tag).toBe("Result");
    expect(calledIds).toEqual(["c:0", "c:1"]);
  });

  it("retires only the id of a discovery that times out after the replacement has connected", async () => {
    const oldDiscovery = Promise.withResolvers<undefined>();
    let discoveries = 0;
    const { manager, rows } = fakeSdkManager({
      discoverOf: (id) => {
        discoveries += 1;
        return id === "c:0" && discoveries === 2
          ? (oldDiscovery.promise as Promise<void>)
          : Promise.resolve();
      },
    });
    const connector = connectorOver(manager);
    await callOf(connector, connector.epochOf("c"));

    const refreshing = connector.refreshTools(entry as never, "owner", {
      timeoutMillis: 1000,
    });
    await vi.waitFor(() => expect(discoveries).toBe(2));
    await connector.forget("c", 20);
    await callOf(connector, connector.epochOf("c"));
    oldDiscovery.reject(
      Object.assign(new Error("timed out"), { code: -32_001 })
    );

    expect(await refreshing).toBe("failed");
    expect(connector.epochOf("c")).toBe(1);
    expect(Object.keys(manager.mcpConnections)).toEqual(["c:1"]);
    await vi.waitFor(() => expect(rows).toEqual(new Set(["c:1"])));
  });

  it("does not retire again for a connect failure of a refresh", async () => {
    const { manager } = fakeSdkManager({
      connectOf: () =>
        Promise.reject(
          Object.assign(new Error("timed out"), { code: -32_001 })
        ),
    });
    const connector = connectorOver(manager);

    const outcome = await connector.refreshTools(entry as never, "owner", {
      timeoutMillis: 1000,
    });

    expect(outcome).toBe("failed");
    expect(connector.epochOf("c")).toBe(1);
  });

  it.each(["close", "closeWhileQueueHeld"] as const)(
    "advances the epoch on %s, so a reconnect gets a new id and the late cleanup of the old close leaves it registered",
    async (way) => {
      const release = Promise.withResolvers<undefined>();
      const { manager, registered, rows } = fakeSdkManager({
        closeOf: (id) =>
          id === "c:0" && way === "closeWhileQueueHeld"
            ? (release.promise as Promise<void>)
            : Promise.resolve(),
      });
      const connector = connectorOver(manager);
      await callOf(connector, connector.epochOf("c"));

      await (way === "close"
        ? connector.close("c", 0)
        : connector.closeWhileQueueHeld("c", 0, 20));
      const reconnected = await callOf(connector, connector.epochOf("c"));
      release.resolve(undefined);
      await vi.waitFor(() => expect(rows).toEqual(new Set(["c:1"])));

      expect(connector.epochOf("c")).toBe(1);
      expect(reconnected._tag).toBe("Result");
      expect(registered).toEqual(["c:0", "c:1"]);
      expect(Object.keys(manager.mcpConnections)).toEqual(["c:1"]);
    }
  );

  it("removes every tracked id that is not current when a connect starts, through the public API", async () => {
    const { manager, registered, removed } = fakeSdkManager();
    const storage = storageStub({ "sdk-servers:c": ["c:0", "c:1", "c:2"] });
    const connector = connectorOver(manager, storage);

    const outcome = await callOf(connector, connector.epochOf("c"));

    expect(outcome._tag).toBe("Result");
    expect(registered).toEqual(["c:0"]);
    await vi.waitFor(() => expect(removed.toSorted()).toEqual(["c:1", "c:2"]));
    await vi.waitFor(() =>
      expect(storage.stored.get("sdk-servers:c")).toEqual(["c:0"])
    );
  });
});
