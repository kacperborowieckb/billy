import { Lifecycle } from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";

import { defaultBehaviorConfig } from "../behavior/behavior-config.ts";
import { OwnerIdSchema } from "../owner-id.ts";
import { personalAgentFor } from "../personal-agent/personal-agent.ts";
import type { McpConnectionState } from "../personal-agent/storage-values.ts";
import { LazyMcpClientManager } from "./lazy-mcp-client-manager.ts";
import { mcpEntryOf } from "./mcp-catalog.ts";
import type { McpCatalog, McpCatalogEntry } from "./mcp-catalog.ts";
import type {
  McpAddConnectionOutcome,
  McpCallbackOutcome,
  McpCallOutcome,
  McpCallRequest,
  McpConsentOutcome,
  McpHubRpc,
  McpOAuthCallback,
  McpOAuthRequest,
  McpOAuthStartOutcome,
} from "./mcp-hub-contract.ts";
import { McpOAuthCompleter } from "./mcp-oauth-completer.ts";
import { McpOAuthStarter } from "./mcp-oauth-starter.ts";
import { guardedFetch } from "./mcp-outbound-guard.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { McpServerConnector } from "./mcp-server-connector.ts";
import { mcpCatalogFor } from "./mcp-test-catalog.ts";
import { SealedCredentials } from "./sealed-credentials.ts";
import { parseSealKeyring } from "./token-seal.ts";
import type { SealKeyring } from "./token-seal.ts";

const sendFromWorker: FetchFunction = (input, init) => fetch(input, init);

const allowedOriginsOf = (env: Env): readonly string[] =>
  env.MCP_TEST_SERVER_URL === ""
    ? []
    : [new URL(env.MCP_TEST_SERVER_URL).origin];

export class McpHub extends DurableObject<Env> implements McpHubRpc {
  protected readonly send: FetchFunction = sendFromWorker;

  protected readonly catalog: McpCatalog = mcpCatalogFor(this.env);

  protected readonly allowedOrigins = allowedOriginsOf(this.env);

  private readonly manager = new LazyMcpClientManager("billy-mcp-hub", "1.0.0");

  readonly lifecycle = Lifecycle.install(this).use(this.manager);

  private keyring: Promise<SealKeyring> | undefined;

  private readonly guardedSend: FetchFunction = (input, init) =>
    guardedFetch(this.send, this.allowedOrigins)(input, init);

  private readonly connector = new McpServerConnector({
    manager: this.manager,
    start: () => this.lifecycle.start(),
    send: (input, init) => this.send(input, init),
    allowedOrigins: this.allowedOrigins,
    credentials: (ownerId) => this.credentialsOf(ownerId),
  });

  private readonly oauth = new McpOAuthStarter({
    catalog: this.catalog,
    send: this.guardedSend,
    allowedOrigins: this.allowedOrigins,
    storage: this.ctx.storage,
    routingId: this.ctx.id.toString(),
    ownerId: () => this.ownerName(),
    credentials: (ownerId) => this.credentialsOf(ownerId),
    isRecorded: (catalogId) => this.isRecorded(catalogId),
    markAuthenticating: (catalogId) =>
      this.tellState(this.ownerName(), catalogId, "authenticating"),
  });

  private readonly completer = new McpOAuthCompleter({
    catalog: this.catalog,
    send: this.guardedSend,
    storage: this.ctx.storage,
    credentials: (ownerId) => this.credentialsOf(ownerId),
    connect: (entry, ownerId, accountLabel) =>
      this.connectAfterConsent(entry, ownerId, accountLabel),
    markFailed: (ownerId, catalogId) =>
      this.tellState(ownerId, catalogId, "failed"),
  });

  private readonly setups = new Map<string, Promise<McpAddConnectionOutcome>>();

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

  private async connectAfterConsent(
    entry: McpCatalogEntry,
    ownerId: string,
    accountLabel: string | undefined
  ): Promise<"connected" | "failed"> {
    try {
      if (
        (await this.connector.ensureConnected(
          entry,
          ownerId,
          defaultBehaviorConfig.mcpConnectTimeoutMillis
        )) === "timed_out"
      ) {
        throw new Error("The MCP server did not connect in time");
      }
      const agent = await this.agentOf(ownerId);
      await agent.receiveMcpConnected(
        entry.catalogId,
        this.connector.toolCopiesOf(entry.catalogId),
        accountLabel
      );
      await this.ctx.storage.put(`connection:${entry.catalogId}`, true);
      return "connected";
    } catch {
      await this.tellState(ownerId, entry.catalogId, "failed");
      return "failed";
    }
  }

  private isRecorded(catalogId: string) {
    return this.ctx.storage
      .get<true>(`connection:${catalogId}`)
      .then((recorded) => recorded === true);
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
    const previous = this.setups.get(catalogId) ?? Promise.resolve();
    const setup = previous
      .catch(() => "earlier setup rejected")
      .then(() => this.setUpConnection(catalogId, connectTimeoutMillis));
    this.setups.set(catalogId, setup);
    return setup;
  }

  private async setUpConnection(
    catalogId: string,
    connectTimeoutMillis: number
  ): Promise<McpAddConnectionOutcome> {
    const entry = mcpEntryOf(this.catalog, catalogId);
    if (entry === undefined) {
      return { outcome: "unknown_catalog_entry" };
    }
    const agent = await this.agentOf(this.ownerName());
    try {
      if (
        (await this.connector.ensureConnected(
          entry,
          this.ownerName(),
          connectTimeoutMillis
        )) === "timed_out"
      ) {
        throw new Error("The MCP server did not connect in time");
      }
      await agent.receiveMcpToolCatalog(
        catalogId,
        this.connector.toolCopiesOf(catalogId)
      );
      await agent.receiveMcpConnectionState(catalogId, "ready");
      await this.ctx.storage.put(`connection:${catalogId}`, true);
      return { outcome: "added" };
    } catch {
      await this.ctx.storage.delete(`connection:${catalogId}`);
      await agent.receiveMcpConnectionState(catalogId, "failed");
      return { outcome: "failed" };
    }
  }

  async callTool(request: McpCallRequest): Promise<McpCallOutcome> {
    const entry = mcpEntryOf(this.catalog, request.catalogId);
    if (entry === undefined || !(await this.isRecorded(request.catalogId))) {
      return { _tag: "Failed", reason: "not_connected" };
    }
    return this.connector.callTool(entry, this.ownerName(), request);
  }
}
