import { DurableObjectOAuthClientProvider } from "agents/mcp/do-oauth-client-provider";
import type { AgentMcpOAuthProvider } from "agents/mcp/do-oauth-client-provider";
import { env, runInDurableObject } from "cloudflare:test";

import type { LazyMcpClientManager } from "../src/mcp/lazy-mcp-client-manager.ts";
import { guardedFetch } from "../src/mcp/mcp-outbound-guard.ts";
import type { FetchFunction } from "../src/mcp/mcp-outbound-guard.ts";
import { testMcpCatalogId } from "../src/mcp/mcp-test-catalog.ts";
import { withinDeadline } from "../src/mcp/oauth-deadline.ts";
import { sealedOAuthStorage } from "../src/mcp/sealed-oauth-storage.ts";
import { parseSealKeyring } from "../src/mcp/token-seal.ts";
import { fakeMcpServer, fakeMcpServerUrl } from "./fakes.ts";

export const callbackUrl = `${env.EDGE_PUBLIC_URL}/oauth/callback`;

export const clientMetadataUrl = `${env.EDGE_PUBLIC_URL}/oauth/client-metadata.json`;

const clientName = "Billy";

const serverId = testMcpCatalogId;

export interface SentRequest {
  readonly path: string;
  readonly hasSignal: boolean;
}

export interface HostOptions {
  readonly oauthDeadlineMillis?: number;
  readonly onInsufficientScope?: "reauthorize" | "throw";
}

const fetchRecordedBy =
  (sent: SentRequest[]): FetchFunction =>
  (input, init) => {
    const request = new Request(input, init);
    sent.push({
      path: new URL(request.url).pathname,
      hasSignal: init?.signal !== undefined && init.signal !== null,
    });
    return fakeMcpServer.fetch(request);
  };

const withOAuthDeadline =
  (send: FetchFunction, deadlineMillis: number): FetchFunction =>
  (input, init) =>
    String(input) === fakeMcpServerUrl
      ? send(input, init)
      : withinDeadline(async (signal) => {
          const response = await send(input, { ...init, signal });
          return new Response(await response.arrayBuffer(), response);
        }, deadlineMillis);

interface LibraryHostInput extends HostOptions {
  readonly manager: LazyMcpClientManager;
  readonly storage: DurableObjectStorage;
  readonly ownerId: string;
}

const libraryHostOf = async ({
  manager,
  storage,
  ownerId,
  oauthDeadlineMillis,
  onInsufficientScope,
}: LibraryHostInput) => {
  const keyring = await parseSealKeyring(env.MCP_SEALING_KEYS);
  const sent: SentRequest[] = [];
  const guarded = guardedFetch(fetchRecordedBy(sent), []);
  const send =
    oauthDeadlineMillis === undefined
      ? guarded
      : withOAuthDeadline(guarded, oauthDeadlineMillis);
  const sealed = sealedOAuthStorage({ storage, keyring, ownerId });

  const libraryProvider = () =>
    new DurableObjectOAuthClientProvider(sealed, clientName, callbackUrl, {
      clientMetadataUrl,
    }) as AgentMcpOAuthProvider;

  const storedClientId = () =>
    manager.listServers().find(({ id }) => id === serverId)?.client_id ??
    undefined;

  const register = async (clientId = storedClientId()) => {
    await manager.registerServer(serverId, {
      url: fakeMcpServerUrl,
      name: "Test",
      callbackUrl,
      ...(clientId === undefined ? {} : { clientId }),
      transport: {
        type: "streamable-http",
        fetch: send,
        authProvider: libraryProvider(),
        ...(onInsufficientScope === undefined ? {} : { onInsufficientScope }),
      },
    });
  };

  const connect = () => manager.connectToServer(serverId);

  const startAuthorization = async () => {
    const connected = await connect();
    if (connected.state !== "authenticating" || !("authUrl" in connected)) {
      throw new Error(`No authorization started: ${connected.state}`);
    }
    const authorizationUrl = new URL(connected.authUrl);
    return {
      authorizationUrl,
      state: authorizationUrl.searchParams.get("state") ?? "",
    };
  };

  const callback = (query: Record<string, string>) =>
    manager.handleCallbackRequest(
      new Request(`${callbackUrl}?${new URLSearchParams(query)}`)
    );

  const establish = () => manager.establishConnection(serverId);

  return {
    sent,
    register,
    connect,
    startAuthorization,
    callback,
    establish,
    forgetConnection: () => manager.closeConnection(serverId),
    search: () =>
      manager.callTool({
        serverId,
        name: "search",
        arguments: { query: "reading" },
      }),
    storedTokens: () => {
      const provider = libraryProvider();
      provider.serverId = serverId;
      provider.clientId = storedClientId() ?? clientMetadataUrl;
      return provider.tokens();
    },
    storedOAuthRecords: async () => {
      const records = await storage.list<string>({ prefix: `/${clientName}/` });
      return [...records.values()];
    },
  };
};

export type LibraryHost = Awaited<ReturnType<typeof libraryHostOf>>;

export const inLibraryHost = <Value>(
  work: (host: LibraryHost) => Promise<Value>,
  options: HostOptions = {}
) => {
  const ownerId = crypto.randomUUID();
  return runInDurableObject(
    env.MCP_HUB.getByName(ownerId),
    async (instance, { storage }) => {
      await instance.lifecycle.start();
      const { manager } = instance as unknown as {
        manager: LazyMcpClientManager;
      };
      return work(
        await libraryHostOf({ ...options, manager, storage, ownerId })
      );
    }
  );
};
