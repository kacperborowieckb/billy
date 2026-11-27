import { DateTime } from "effect";

import { KeyedQueue } from "./keyed-queue.ts";
import { mcpEntryOf } from "./mcp-catalog.ts";
import type { McpCatalog, McpCatalogEntry } from "./mcp-catalog.ts";
import { exchangeAndStore } from "./mcp-code-exchange.ts";
import type {
  McpCallbackOutcome,
  McpOAuthCallback,
} from "./mcp-hub-contract.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { pendingOAuthOf } from "./oauth-start.ts";
import type { PendingOAuth } from "./oauth-start.ts";
import {
  connectionRecordKey,
  isConnectionRecorded,
  latestExchangeKey,
  pendingOAuthKeyPrefix,
  settledOAuthKeyPrefix,
  settledOAuthOf,
} from "./oauth-storage-keys.ts";
import type { SealedCredentials } from "./sealed-credentials.ts";

const nowMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe());

export interface McpCompletion {
  readonly entry: McpCatalogEntry;
  readonly ownerId: string;
  readonly completionId: string;
  readonly accountLabel: string | undefined;
}

export interface McpOAuthCompleterDependencies {
  readonly catalog: McpCatalog;
  readonly send: FetchFunction;
  readonly storage: DurableObjectStorage;
  readonly credentials: (ownerId: string) => Promise<SealedCredentials>;
  readonly connect: (
    completion: McpCompletion
  ) => Promise<"connected" | "failed">;
  readonly markFailed: (ownerId: string, catalogId: string) => Promise<void>;
}

const hasText = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

type IssuerRule = Pick<PendingOAuth, "issuer" | "issuerIsRequired">;

interface RunningCallback {
  readonly issuerRule: Promise<IssuerRule | undefined>;
  readonly outcome: Promise<McpCallbackOutcome>;
}

const issuerAgrees = (pending: IssuerRule, iss: string | undefined) =>
  iss === undefined ? !pending.issuerIsRequired : iss === pending.issuer;

const joinRunning = async (
  running: RunningCallback,
  iss: string | undefined
): Promise<McpCallbackOutcome> => {
  const rule = await running.issuerRule;
  return rule !== undefined && !issuerAgrees(rule, iss)
    ? { outcome: "not_started" }
    : running.outcome;
};

export class McpOAuthCompleter {
  private readonly dependencies: McpOAuthCompleterDependencies;

  private readonly running = new Map<string, RunningCallback>();

  private readonly entryQueue = new KeyedQueue();

  constructor(dependencies: McpOAuthCompleterDependencies) {
    this.dependencies = dependencies;
  }

  complete(returned: McpOAuthCallback): Promise<McpCallbackOutcome> {
    const { nonce } = returned;
    const running = this.running.get(nonce);
    if (running !== undefined) {
      return joinRunning(running, returned.iss);
    }
    const issuerRule = this.issuerRuleOf(nonce);
    const outcome = this.run(returned).finally(() => {
      this.running.delete(nonce);
    });
    this.running.set(nonce, { issuerRule, outcome });
    return outcome;
  }

  private async issuerRuleOf(nonce: string): Promise<IssuerRule | undefined> {
    const { storage } = this.dependencies;
    const pending = pendingOAuthOf(
      await storage.get(`${pendingOAuthKeyPrefix}${nonce}`)
    );
    return (
      pending ??
      settledOAuthOf(await storage.get(`${settledOAuthKeyPrefix}${nonce}`))
    );
  }

  private async isRecorded(catalogId: string) {
    return isConnectionRecorded(
      await this.dependencies.storage.get(connectionRecordKey(catalogId))
    );
  }

  private async replayOf(
    nonce: string,
    iss: string | undefined
  ): Promise<McpCallbackOutcome> {
    const { storage, catalog } = this.dependencies;
    const settled = settledOAuthOf(
      await storage.get(`${settledOAuthKeyPrefix}${nonce}`)
    );
    const entry =
      settled === undefined || settled.expiresAtMillis <= nowMillis()
        ? undefined
        : mcpEntryOf(catalog, settled.catalogId);
    if (
      settled === undefined ||
      entry === undefined ||
      !issuerAgrees(settled, iss)
    ) {
      return { outcome: "not_started" };
    }
    const serverName = entry.displayName;
    return this.entryQueue.run(entry.catalogId, async () => {
      const latest = await storage.get(latestExchangeKey(entry.catalogId));
      if (latest !== nonce) {
        return { outcome: "not_started" };
      }
      const connected = await this.dependencies.connect({
        entry,
        ownerId: settled.ownerId,
        completionId: nonce,
        accountLabel: settled.accountLabel,
      });
      return { outcome: connected, serverName };
    });
  }

  private async run(returned: McpOAuthCallback): Promise<McpCallbackOutcome> {
    const { storage, catalog } = this.dependencies;
    const key = `${pendingOAuthKeyPrefix}${returned.nonce}`;
    const pending = pendingOAuthOf(await storage.get(key));
    if (pending === undefined || pending.expiresAtMillis <= nowMillis()) {
      return this.replayOf(returned.nonce, returned.iss);
    }
    const entry = mcpEntryOf(catalog, pending.catalogId);
    if (entry === undefined || !issuerAgrees(pending, returned.iss)) {
      return { outcome: "not_started" };
    }
    const { code, error } = returned;
    if (!hasText(code) && !hasText(error)) {
      return { outcome: "not_started" };
    }
    await storage.delete(key);
    return this.entryQueue.run(entry.catalogId, () =>
      this.finish(entry, pending, returned)
    );
  }

  private async finish(
    entry: McpCatalogEntry,
    pending: PendingOAuth,
    returned: McpOAuthCallback
  ): Promise<McpCallbackOutcome> {
    const { code, error } = returned;
    const serverName = entry.displayName;
    if (await this.isRecorded(entry.catalogId)) {
      return { outcome: "already_connected", serverName };
    }
    if (hasText(error) || !hasText(code)) {
      await this.dependencies.markFailed(pending.ownerId, entry.catalogId);
      return { outcome: "denied", serverName };
    }
    const exchanged = await exchangeAndStore(this.dependencies, {
      entry,
      pending,
      nonce: returned.nonce,
      code,
    });
    if (exchanged._tag === "Failed") {
      await this.dependencies.markFailed(pending.ownerId, entry.catalogId);
      return { outcome: "failed", serverName };
    }
    const connected = await this.dependencies.connect({
      entry,
      ownerId: pending.ownerId,
      completionId: returned.nonce,
      accountLabel: exchanged.label,
    });
    return { outcome: connected, serverName };
  }
}
