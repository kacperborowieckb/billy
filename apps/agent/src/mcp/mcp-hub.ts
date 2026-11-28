import { Lifecycle } from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";

import { OwnerIdSchema } from "../owner-id.ts";
import { personalAgentFor } from "../personal-agent/personal-agent.ts";
import type { McpConnectionState } from "../personal-agent/storage-values.ts";
import { KeyedQueue } from "./keyed-queue.ts";
import { LazyMcpClientManager } from "./lazy-mcp-client-manager.ts";
import { allowedOriginsOf } from "./mcp-allowed-origins.ts";
import { McpCallGateway } from "./mcp-call-gateway.ts";
import { mcpCatalogFor } from "./mcp-catalog-for-env.ts";
import { mcpEntryOf } from "./mcp-catalog.ts";
import type { McpCatalog } from "./mcp-catalog.ts";
import { McpConnectionHealth } from "./mcp-connection-health.ts";
import { McpConnectionLedger } from "./mcp-connection-ledger.ts";
import { McpConnectionSetup } from "./mcp-connection-setup.ts";
import { McpDisconnector } from "./mcp-disconnector.ts";
import type {
  McpAddConnectionOutcome,
  McpCallbackOutcome,
  McpCallOutcome,
  McpCallRequest,
  McpConsentOutcome,
  McpHubRpc,
  McpRefreshOutcome,
  McpOAuthCallback,
  McpOAuthRequest,
  McpOAuthStartOutcome,
} from "./mcp-hub-contract.ts";
import { McpOAuthCompleter } from "./mcp-oauth-completer.ts";
import { McpOAuthStarter } from "./mcp-oauth-starter.ts";
import { guardedFetch } from "./mcp-outbound-guard.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { McpServerConnector } from "./mcp-server-connector.ts";
import { McpToolCopySync } from "./mcp-tool-copy-sync.ts";
import type { McpLastError } from "./oauth-storage-keys.ts";
import { SealedCredentials } from "./sealed-credentials.ts";
import { parseSealKeyring } from "./token-seal.ts";
import type { SealKeyring } from "./token-seal.ts";

const sendFromWorker: FetchFunction = (input, init) => fetch(input, init);

export class McpHub extends DurableObject<Env> implements McpHubRpc {
  protected readonly send: FetchFunction = sendFromWorker;

  protected readonly catalog: McpCatalog = mcpCatalogFor(this.env);

  protected readonly allowedOrigins = allowedOriginsOf(this.env);

  private readonly manager = new LazyMcpClientManager("billy-mcp-hub", "1.0.0");

  readonly lifecycle = Lifecycle.install(this).use(this.manager);

  private keyring: Promise<SealKeyring> | undefined;

  private readonly guardedSend: FetchFunction = (input, init) =>
    guardedFetch(this.send, this.allowedOrigins)(input, init);

  private readonly ledger = new McpConnectionLedger(this.ctx.storage);

  private readonly entryQueue = new KeyedQueue();

  private readonly health = new McpConnectionHealth({
    entryQueue: this.entryQueue,
    ledger: this.ledger,
    send: this.guardedSend,
    credentials: (ownerId) => this.credentialsOf(ownerId),
    tellNeedsSignIn: (ownerId, catalogId) =>
      this.tellStateQuietly(ownerId, catalogId, "needs_sign_in"),
  });

  private readonly connector = new McpServerConnector({
    manager: this.manager,
    storage: this.ctx.storage,
    start: () => this.lifecycle.start(),
    send: (input, init) => this.send(input, init),
    allowedOrigins: this.allowedOrigins,
    credentials: (ownerId) => this.credentialsOf(ownerId),
    health: this.health,
  });

  private readonly toolCopies = new McpToolCopySync({
    catalog: this.catalog,
    entryQueue: this.entryQueue,
    ledger: this.ledger,
    epochOf: (catalogId) => this.connector.epochOf(catalogId),
    isLive: (catalogId, epoch) => this.connector.isLive(catalogId, epoch),
    copiesOf: (id, epoch) => this.connector.toolCopiesOf(id, epoch),
    refreshTools: (catalogId, ownerId, options) => {
      const entry = mcpEntryOf(this.catalog, catalogId);
      return entry === undefined
        ? Promise.resolve("failed" as const)
        : this.connector.refreshTools(entry, ownerId, options);
    },
    closeLive: (id, epoch) => this.connector.close(id, epoch),
    deliver: async (catalogId, copies) => {
      const agent = await this.agentOf(this.ownerName());
      await agent.receiveMcpToolCatalog(catalogId, copies);
    },
  });

  private readonly toolListWatch = this.manager.onServerStateChanged(() => {
    // oxlint-disable-next-line no-void
    void this.toolCopies.onServerStateChanged();
  });

  private readonly oauth = new McpOAuthStarter({
    entryQueue: this.entryQueue,
    catalog: this.catalog,
    send: this.guardedSend,
    allowedOrigins: this.allowedOrigins,
    storage: this.ctx.storage,
    routingId: this.ctx.id.toString(),
    ownerId: () => this.ownerName(),
    credentials: (ownerId) => this.credentialsOf(ownerId),
    isReady: (catalogId) => this.ledger.isReady(catalogId),
    isBeingRemoved: (catalogId) => this.ledger.isBeingRemoved(catalogId),
    entryEpochOf: (catalogId) => this.connector.epochOf(catalogId),
    markAuthenticating: async (catalogId) => {
      if ((await this.ledger.stateOf(catalogId)) === undefined) {
        await this.tellState(this.ownerName(), catalogId, "authenticating");
      }
    },
  });

  protected readonly completer = new McpOAuthCompleter({
    entryQueue: this.entryQueue,
    catalog: this.catalog,
    send: this.guardedSend,
    storage: this.ctx.storage,
    credentials: (ownerId) => this.credentialsOf(ownerId),
    isReady: (catalogId) => this.ledger.isReady(catalogId),
    connect: (completion) => this.setup.connectAfterConsent(completion),
    markFailed: async (ownerId, catalogId) => {
      await this.ledger.recordError(catalogId, {
        phase: "token_exchange",
        reason: "failed",
      });
      await this.tellState(ownerId, catalogId, "failed");
    },
  });

  private readonly calls = new McpCallGateway({
    catalog: this.catalog,
    entryQueue: this.entryQueue,
    ledger: this.ledger,
    connector: this.connector,
    ownerId: () => this.ownerName(),
    tellNeedsSignIn: (ownerId, catalogId) =>
      this.tellStateQuietly(ownerId, catalogId, "needs_sign_in"),
  });

  private readonly setup = new McpConnectionSetup({
    catalog: this.catalog,
    entryQueue: this.entryQueue,
    health: this.health,
    connector: this.connector,
    ledger: this.ledger,
    toolCopies: this.toolCopies,
    ownerId: () => this.ownerName(),
    agentOf: (ownerId) => this.agentOf(ownerId),
    closeConnection: (catalogId, epoch) => this.closeQuietly(catalogId, epoch),
  });

  private readonly disconnector = new McpDisconnector({
    catalog: this.catalog,
    ledger: this.ledger,
    entryQueue: this.entryQueue,
    connector: this.connector,
    storage: this.ctx.storage,
    send: this.guardedSend,
    ownerId: () => this.ownerName(),
    credentials: (ownerId) => this.credentialsOf(ownerId),
  });

  private ownerName() {
    return this.ctx.id.name ?? "";
  }

  private async credentialsOf(ownerId: string) {
    this.keyring ??= parseSealKeyring(this.env.MCP_SEALING_KEYS);
    try {
      return new SealedCredentials(
        this.ctx.storage,
        await this.keyring,
        ownerId
      );
    } catch (error) {
      this.keyring = undefined;
      await Effect.runPromise(
        Effect.logError("The MCP sealing key is missing or invalid")
      );
      throw error;
    }
  }

  private agentOf(ownerId: string) {
    return personalAgentFor(
      this.env.PERSONAL_AGENT,
      OwnerIdSchema.make(ownerId)
    );
  }

  private async tellState(
    ownerId: string,
    catalogId: string,
    state: McpConnectionState
  ) {
    const agent = await this.agentOf(ownerId);
    await agent.receiveMcpConnectionState(catalogId, state);
  }

  private async tellStateQuietly(
    ownerId: string,
    catalogId: string,
    state: McpConnectionState
  ) {
    try {
      await this.tellState(ownerId, catalogId, state);
    } catch (error) {
      await Effect.runPromise(
        Effect.logWarning("The Personal Agent did not get the MCP state", error)
      );
    }
  }

  private async closeQuietly(catalogId: string, epoch: number) {
    try {
      await this.connector.close(catalogId, epoch);
    } catch (error) {
      await Effect.runPromise(
        Effect.logWarning("The MCP connection did not close", error)
      );
    }
  }

  describeConsent(request: McpOAuthRequest): Promise<McpConsentOutcome> {
    return this.oauth.describeConsent(request);
  }

  startOAuth(request: McpOAuthRequest): Promise<McpOAuthStartOutcome> {
    return this.oauth.startOAuth(request);
  }

  completeOAuth(returned: McpOAuthCallback): Promise<McpCallbackOutcome> {
    return this.completer.complete(returned);
  }

  addConnection(
    catalogId: string,
    connectTimeoutMillis: number
  ): Promise<McpAddConnectionOutcome> {
    return this.setup.add(catalogId, connectTimeoutMillis);
  }

  callTool(request: McpCallRequest): Promise<McpCallOutcome> {
    return this.calls.callTool(request);
  }

  disconnect(catalogId: string) {
    return this.disconnector.disconnect(catalogId);
  }

  acknowledgeRemoval(catalogId: string): Promise<void> {
    return this.disconnector.acknowledgeRemoval(catalogId);
  }

  removeOwnerStorage(): Promise<void> {
    return this.disconnector.removeAll();
  }

  lastError(catalogId: string): Promise<McpLastError | undefined> {
    return this.ledger.lastErrorOf(catalogId);
  }

  refreshToolCatalog(
    catalogId: string,
    connectTimeoutMillis: number
  ): Promise<McpRefreshOutcome> {
    return this.toolCopies.refresh(
      catalogId,
      this.ownerName(),
      connectTimeoutMillis
    );
  }
}
