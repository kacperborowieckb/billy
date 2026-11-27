import { describe, expect, it, vi } from "vitest";

import { McpServerConnector } from "../src/mcp/mcp-server-connector.ts";
import { revokeTokens } from "../src/mcp/oauth-token-revocation.ts";

interface FakeConnection {
  connectionState: "ready";
  close: () => Promise<void>;
}

const fakeSdkManager = (
  closeOf: (id: string) => Promise<void> = () => Promise.resolve()
) => {
  const mcpConnections: Record<string, FakeConnection> = {};
  const registered: string[] = [];
  const removed: string[] = [];
  const closeAttempts: string[] = [];
  const manager = {
    mcpConnections,
    registerServer: (id: string) => {
      registered.push(id);
      mcpConnections[id] = {
        connectionState: "ready",
        close: () => closeOf(id),
      };
      return Promise.resolve(id);
    },
    connectToServer: () => Promise.resolve({ state: "connected" }),
    discoverIfConnected: () => Promise.resolve({ success: true }),
    listTools: () => [],
    callTool: () => Promise.resolve({ content: [], isError: false }),
    closeConnection: async (id: string) => {
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
    },
    removeServer: (id: string) => {
      removed.push(id);
      return Promise.resolve();
    },
  };
  return { manager, registered, removed, closeAttempts };
};

const storageStub = (initial: Record<string, unknown> = {}) => {
  const stored = new Map(Object.entries(initial));
  return {
    get: (key: string) => Promise.resolve(stored.get(key)),
    put: (key: string, value: unknown) => {
      stored.set(key, value);
      return Promise.resolve();
    },
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

    expect(outcome).toEqual({ _tag: "Failed", reason: "failed" });
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

  it("gives up a close that never ends when the deadline comes", async () => {
    const { manager } = fakeSdkManager(
      () => Promise.withResolvers<undefined>().promise as Promise<void>
    );
    const connector = connectorOver(manager);
    await callOf(connector, connector.epochOf("c"));

    await expect(connector.forget("c", 20)).resolves.toBeUndefined();
  });
});

describe("a close that hangs past its deadline", () => {
  it("lets a reconnect register under a new SDK id, and the late cleanup of the old id leaves the new connection registered", async () => {
    const lateClose = Promise.withResolvers<undefined>();
    const { manager, registered, removed, closeAttempts } = fakeSdkManager(
      (id) =>
        id === "c:0" ? (lateClose.promise as Promise<void>) : Promise.resolve()
    );
    const storage = storageStub();
    const connector = connectorOver(manager, storage);
    await callOf(connector, connector.epochOf("c"));

    await connector.forget("c", 20);
    const reconnected = await callOf(connector, connector.epochOf("c"));
    lateClose.resolve(undefined);
    await vi.waitFor(() => expect(removed).toContain("c:0"));
    const afterLateSettle = await callOf(connector, connector.epochOf("c"));

    expect(reconnected._tag).toBe("Result");
    expect(afterLateSettle._tag).toBe("Result");
    expect(Object.keys(manager.mcpConnections)).toEqual(["c:1"]);
    expect(registered).toEqual(["c:0", "c:1"]);
    expect(closeAttempts).toEqual(["c:0"]);
    expect(removed).not.toContain("c:1");
    expect(storage.stored.get("sdk-servers:c")).toEqual(["c:1"]);
  });
});

describe("the SDK server records after a restart", () => {
  it("removes the records of old ids through the public API and keeps the current one", async () => {
    const { manager, registered, removed } = fakeSdkManager();
    const storage = storageStub({ "sdk-servers:c": ["c:0", "c:1", "c:2"] });
    const connector = connectorOver(manager, storage);

    const outcome = await callOf(connector, connector.epochOf("c"));

    expect(outcome._tag).toBe("Result");
    expect(registered).toEqual(["c:0"]);
    expect(removed.toSorted()).toEqual(["c:1", "c:2"]);
    expect(storage.stored.get("sdk-servers:c")).toEqual(["c:0"]);
  });
});
