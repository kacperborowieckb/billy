import { defaultBehaviorConfig } from "../behavior/behavior-config.ts";
import type { personalAgentFor } from "../personal-agent/personal-agent.ts";
import type { KeyedQueue } from "./keyed-queue.ts";
import { mcpEntryOf } from "./mcp-catalog.ts";
import type { McpCatalog } from "./mcp-catalog.ts";
import type { McpConnectionHealth } from "./mcp-connection-health.ts";
import type { McpConnectionLedger } from "./mcp-connection-ledger.ts";
import {
  failureReasonOf,
  logMcpFailure,
  toolCopySizeOf,
} from "./mcp-failure.ts";
import type { McpAddConnectionOutcome } from "./mcp-hub-contract.ts";
import type { McpCompletion } from "./mcp-oauth-completer.ts";
import type { McpServerConnector } from "./mcp-server-connector.ts";
import type { McpToolCopySync } from "./mcp-tool-copy-sync.ts";

type PersonalAgentStub = Awaited<ReturnType<typeof personalAgentFor>>;

export interface McpConnectionSetupDependencies {
  readonly catalog: McpCatalog;
  readonly entryQueue: KeyedQueue;
  readonly health: McpConnectionHealth;
  readonly connector: McpServerConnector;
  readonly ledger: McpConnectionLedger;
  readonly toolCopies: McpToolCopySync;
  readonly ownerId: () => string;
  readonly agentOf: (ownerId: string) => Promise<PersonalAgentStub>;
  readonly closeConnection: (catalogId: string, epoch: number) => Promise<void>;
}

const connectTimedOut = "The MCP server did not connect in time";

const logConnectFailure = (
  catalogId: string,
  reason: string,
  size?: ReturnType<typeof toolCopySizeOf>
) => logMcpFailure({ phase: "connect", reason, catalogId, ...size });

export class McpConnectionSetup {
  private readonly dependencies: McpConnectionSetupDependencies;

  constructor(dependencies: McpConnectionSetupDependencies) {
    this.dependencies = dependencies;
  }

  private async recordFailure(catalogId: string) {
    const { ledger } = this.dependencies;
    await ledger.remove(catalogId);
    await ledger.recordError(catalogId, { phase: "connect", reason: "failed" });
  }

  connectAfterConsent({
    entry,
    ownerId,
    completionId,
    accountLabel,
  }: McpCompletion): Promise<"connected" | "failed"> {
    return this.dependencies.connector.whileQueueHeld(entry.catalogId, () =>
      this.connectHoldingQueue({ entry, ownerId, completionId, accountLabel })
    );
  }

  private async connectHoldingQueue({
    entry,
    ownerId,
    completionId,
    accountLabel,
  }: McpCompletion): Promise<"connected" | "failed"> {
    const { connector, ledger, toolCopies, agentOf, closeConnection } =
      this.dependencies;
    const epoch = connector.epochOf(entry.catalogId);
    let size: ReturnType<typeof toolCopySizeOf> | undefined;
    try {
      if (
        (await connector.ensureConnected(entry, ownerId, {
          timeoutMillis: defaultBehaviorConfig.mcpConnectTimeoutMillis,
          holdsEntryQueue: true,
          epoch,
        })) === "timed_out"
      ) {
        throw new Error(connectTimedOut);
      }
      const tools = connector.toolCopiesOf(entry.catalogId, epoch);
      size = toolCopySizeOf(tools);
      const agent = await agentOf(ownerId);
      await ledger.markReady(entry.catalogId);
      toolCopies.remember(entry.catalogId, tools);
      await agent.receiveMcpConnected({
        catalogId: entry.catalogId,
        tools,
        accountLabel,
        completionId,
      });
      return "connected";
    } catch (error) {
      await logConnectFailure(entry.catalogId, failureReasonOf(error), size);
      await this.recordFailure(entry.catalogId);
      await closeConnection(entry.catalogId, epoch);
      const agent = await agentOf(ownerId);
      await agent.receiveMcpConnectionState(entry.catalogId, "failed");
      return "failed";
    }
  }

  add(
    catalogId: string,
    connectTimeoutMillis: number
  ): Promise<McpAddConnectionOutcome> {
    return this.dependencies.entryQueue.run(catalogId, () =>
      this.setUp(catalogId, connectTimeoutMillis)
    );
  }

  private async setUp(
    catalogId: string,
    connectTimeoutMillis: number
  ): Promise<McpAddConnectionOutcome> {
    const { catalog, connector, ledger, ownerId, agentOf, health } =
      this.dependencies;
    const entry = mcpEntryOf(catalog, catalogId);
    if (entry === undefined) {
      return { outcome: "unknown_catalog_entry" };
    }
    if (
      (await ledger.stateOf(catalogId)) === "needs_sign_in" ||
      (await ledger.isBeingRemoved(catalogId))
    ) {
      await logConnectFailure(catalogId, "not_open_to_a_connection");
      return { outcome: "failed" };
    }
    const fresh = await health.refreshWhileQueueHeld(entry, ownerId());
    if (fresh._tag === "SignInRequired") {
      await logConnectFailure(catalogId, "sign_in_required");
      return { outcome: "failed" };
    }
    const agent = await agentOf(ownerId());
    const epoch = connector.epochOf(catalogId);
    try {
      if (
        (await connector.ensureConnected(entry, ownerId(), {
          timeoutMillis: connectTimeoutMillis,
          holdsEntryQueue: true,
          epoch,
        })) === "timed_out"
      ) {
        throw new Error(connectTimedOut);
      }
      await agent.receiveMcpToolCatalog(
        catalogId,
        connector.toolCopiesOf(catalogId, epoch)
      );
      await agent.receiveMcpConnectionState(catalogId, "ready");
      await ledger.markReady(catalogId);
      return { outcome: "added" };
    } catch (error) {
      await logConnectFailure(catalogId, failureReasonOf(error));
      await this.recordFailure(catalogId);
      await agent.receiveMcpConnectionState(catalogId, "failed");
      return { outcome: "failed" };
    }
  }
}
