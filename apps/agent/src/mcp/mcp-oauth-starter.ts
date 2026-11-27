import { mcpEntryOf } from "./mcp-catalog.ts";
import type { McpCatalog, McpCatalogEntry } from "./mcp-catalog.ts";
import type {
  McpConsentOutcome,
  McpOAuthRequest,
  McpOAuthStartOutcome,
} from "./mcp-hub-contract.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { discoverOAuth } from "./oauth-discovery.ts";
import { startOAuth } from "./oauth-start.ts";
import type { PendingOAuth } from "./oauth-start.ts";

const pendingOAuthKeyPrefix = "oauth:";

const oauthStartLifetimeMillis = 10 * 60 * 1000;

export interface McpOAuthStarterDependencies {
  readonly catalog: McpCatalog;
  readonly send: FetchFunction;
  readonly allowedOrigins: readonly string[];
  readonly storage: DurableObjectStorage;
  readonly routingId: string;
  readonly isRecorded: (catalogId: string) => Promise<boolean>;
  readonly markAuthenticating: (catalogId: string) => Promise<void>;
}

type Checked =
  | {
      readonly _tag: "Refused";
      readonly outcome: "unknown_catalog_entry" | "already_connected";
    }
  | { readonly _tag: "Allowed"; readonly entry: McpCatalogEntry };

export class McpOAuthStarter {
  private readonly dependencies: McpOAuthStarterDependencies;

  constructor(dependencies: McpOAuthStarterDependencies) {
    this.dependencies = dependencies;
  }

  private async check(request: McpOAuthRequest): Promise<Checked> {
    const entry = mcpEntryOf(this.dependencies.catalog, request.catalogId);
    if (entry === undefined) {
      return { _tag: "Refused", outcome: "unknown_catalog_entry" };
    }
    if (await this.dependencies.isRecorded(request.catalogId)) {
      return { _tag: "Refused", outcome: "already_connected" };
    }
    return { _tag: "Allowed", entry };
  }

  private discover(entry: McpCatalogEntry, request: McpOAuthRequest) {
    const { send, allowedOrigins } = this.dependencies;
    return discoverOAuth({
      send,
      allowedOrigins,
      serverUrl: entry.serverUrl,
      clientMetadataUrl: request.clientMetadataUrl,
    });
  }

  async describeConsent(request: McpOAuthRequest): Promise<McpConsentOutcome> {
    const checked = await this.check(request);
    if (checked._tag === "Refused") {
      return { outcome: checked.outcome };
    }
    try {
      const { server, clientMode } = await this.discover(
        checked.entry,
        request
      );
      return {
        outcome: "ready_to_consent",
        serverName: checked.entry.displayName,
        authorizationServer: new URL(server.authorization_endpoint).origin,
        clientMode,
      };
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async startOAuth(request: McpOAuthRequest): Promise<McpOAuthStartOutcome> {
    const checked = await this.check(request);
    if (checked._tag === "Refused") {
      return { outcome: checked.outcome };
    }
    const { entry } = checked;
    try {
      const started = await startOAuth({
        send: this.dependencies.send,
        discovery: await this.discover(entry, request),
        catalogId: entry.catalogId,
        serverUrl: entry.serverUrl,
        redirectUrl: request.redirectUrl,
        clientMetadataUrl: request.clientMetadataUrl,
        clientName: "Billy",
        routingId: this.dependencies.routingId,
        nowMillis: Date.now(),
        lifetimeMillis: oauthStartLifetimeMillis,
      });
      await this.dependencies.storage.put<PendingOAuth>(
        `${pendingOAuthKeyPrefix}${started.nonce}`,
        started.pending
      );
      await this.forgetExpired();
      await this.dependencies.markAuthenticating(entry.catalogId);
      return {
        outcome: "redirect",
        authorizationUrl: started.authorizationUrl,
      };
    } catch {
      return { outcome: "unavailable" };
    }
  }

  private async forgetExpired() {
    const { storage } = this.dependencies;
    const pending = await storage.list<PendingOAuth>({
      prefix: pendingOAuthKeyPrefix,
    });
    const now = Date.now();
    const expired = [...pending]
      .filter(([, value]) => value.expiresAtMillis <= now)
      .map(([key]) => key);
    if (expired.length > 0) {
      await storage.delete(expired);
    }
  }
}
