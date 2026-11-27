import { Option } from "effect";

import type { LazyMcpClientManager } from "./lazy-mcp-client-manager.ts";
import type { AdmittedCall } from "./mcp-admitted-call.ts";
import type { McpCatalogEntry } from "./mcp-catalog.ts";
import type { McpConnectionHealth } from "./mcp-connection-health.ts";
import { isDeadlineError } from "./mcp-deadline-error.ts";
import type { McpCallOutcome } from "./mcp-hub-contract.ts";
import { resultOutcomeOf, toolCopyOf } from "./mcp-hub-results.ts";
import { guardedFetch } from "./mcp-outbound-guard.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { McpQueueHolds } from "./mcp-queue-holds.ts";
import { McpSdkServers, sdkIdOf } from "./mcp-sdk-servers.ts";
import { serverRegistrationOf } from "./mcp-server-registration.ts";
import { within } from "./mcp-within.ts";
import type { SealedCredentials } from "./sealed-credentials.ts";

const closeDeadlineMillis = 3000;

export interface McpServerConnectorDependencies {
  readonly manager: LazyMcpClientManager;
  readonly storage: DurableObjectStorage;
  readonly start: () => Promise<unknown>;
  readonly send: FetchFunction;
  readonly allowedOrigins: readonly string[];
  readonly credentials: (ownerId: string) => Promise<SealedCredentials>;
  readonly health: McpConnectionHealth;
}

export interface ConnectOptions {
  readonly timeoutMillis: number;
  readonly holdsEntryQueue?: boolean;
  readonly epoch?: number;
}

export class McpServerConnector {
  private readonly dependencies: McpServerConnectorDependencies;

  private readonly queueHolds = new McpQueueHolds();

  private readonly servers: McpSdkServers;

  constructor(dependencies: McpServerConnectorDependencies) {
    this.dependencies = dependencies;
    this.servers = new McpSdkServers(
      dependencies.manager,
      dependencies.storage
    );
  }

  epochOf(catalogId: string) {
    return this.servers.epochOf(catalogId);
  }

  isLive(catalogId: string, epoch: number) {
    return (
      this.epochOf(catalogId) === epoch &&
      this.servers.isReady(sdkIdOf(catalogId, epoch))
    );
  }

  private async registerAndConnect(
    entry: McpCatalogEntry,
    ownerId: string,
    epoch: number
  ) {
    const { manager, send, allowedOrigins, credentials, health } =
      this.dependencies;
    const { catalogId } = entry;
    const sdkId = sdkIdOf(catalogId, epoch);
    const whileCurrent = async <Value>(step: Promise<Value>) => {
      const value = await step;
      this.servers.refuseWhenRetired(catalogId, epoch);
      return value;
    };
    const sealedCredentials = await whileCurrent(credentials(ownerId));
    await whileCurrent(this.servers.dropStale(catalogId, sdkId));
    await whileCurrent(this.servers.track(catalogId, sdkId));
    await whileCurrent(
      manager.registerServer(
        sdkId,
        serverRegistrationOf({
          credentials: sealedCredentials,
          send: guardedFetch(send, allowedOrigins),
          entry,
          ownerId,
          health,
          queueWaitsOnConnect: () => this.queueHolds.isHeld(catalogId),
        })
      )
    );
    const connected = await whileCurrent(manager.connectToServer(sdkId));
    if (connected.state !== "connected") {
      throw new Error("The MCP server is not connected");
    }
    const discovered = await whileCurrent(manager.discoverIfConnected(sdkId));
    if (discovered?.success !== true) {
      throw new Error("The MCP server did not list its tools");
    }
  }

  ensureConnected(
    entry: McpCatalogEntry,
    ownerId: string,
    {
      timeoutMillis,
      holdsEntryQueue = false,
      epoch = this.epochOf(entry.catalogId),
    }: ConnectOptions
  ): Promise<"connected" | "timed_out"> {
    if (!holdsEntryQueue) {
      return this.connectWhenNeeded(entry, ownerId, { timeoutMillis, epoch });
    }
    return this.whileQueueHeld(entry.catalogId, () =>
      this.connectWhenNeeded(entry, ownerId, { timeoutMillis, epoch })
    );
  }

  whileQueueHeld<Value>(catalogId: string, work: () => Promise<Value>) {
    return this.queueHolds.whileHeld(catalogId, work);
  }

  private async connectWhenNeeded(
    entry: McpCatalogEntry,
    ownerId: string,
    {
      timeoutMillis: connectTimeoutMillis,
      epoch = this.epochOf(entry.catalogId),
    }: ConnectOptions
  ): Promise<"connected" | "timed_out"> {
    const sdkId = sdkIdOf(entry.catalogId, epoch);
    await this.dependencies.start();
    if (this.isLive(entry.catalogId, epoch)) {
      return "connected";
    }
    const connected = await within(
      this.servers.connectOnce(entry.catalogId, sdkId, () =>
        this.registerAndConnect(entry, ownerId, epoch)
      ),
      connectTimeoutMillis
    );
    if (Option.isSome(connected)) {
      return "connected";
    }
    this.servers.retire(entry.catalogId, sdkId);
    return "timed_out";
  }

  private retireAtDeadline(catalogId: string, sdkId: string, error: unknown) {
    if (isDeadlineError(error)) {
      this.servers.retire(catalogId, sdkId);
    }
  }

  async refreshTools(
    entry: McpCatalogEntry,
    ownerId: string,
    { timeoutMillis, epoch = this.epochOf(entry.catalogId) }: ConnectOptions
  ): Promise<"refreshed" | "failed" | "timed_out"> {
    const sdkId = sdkIdOf(entry.catalogId, epoch);
    try {
      const connected = await this.connectWhenNeeded(entry, ownerId, {
        timeoutMillis,
        epoch,
      });
      if (connected === "timed_out") {
        return "timed_out";
      }
    } catch {
      return "failed";
    }
    try {
      const discovered =
        await this.dependencies.manager.discoverIfConnected(sdkId);
      return discovered?.success === true ? "refreshed" : "failed";
    } catch (error) {
      this.retireAtDeadline(entry.catalogId, sdkId, error);
      return "failed";
    }
  }

  close(catalogId: string, epoch: number) {
    return this.closeWhileQueueHeld(catalogId, epoch, closeDeadlineMillis);
  }

  closeWhileQueueHeld(
    catalogId: string,
    epoch: number,
    deadlineMillis: number
  ) {
    const sdkId = sdkIdOf(catalogId, epoch);
    return this.whileQueueHeld(catalogId, () =>
      this.servers.closeWithin(catalogId, sdkId, deadlineMillis)
    );
  }

  async forget(catalogId: string, deadlineMillis: number) {
    const closedEpoch = this.epochOf(catalogId);
    const closedSdkId = sdkIdOf(catalogId, closedEpoch);
    const running = this.servers.connectOf(closedSdkId);
    this.servers.retire(catalogId, closedSdkId);
    if (running !== undefined) {
      await within(
        running.catch(() => null),
        deadlineMillis
      ).catch(() => null);
    }
    await this.closeWhileQueueHeld(catalogId, closedEpoch, deadlineMillis);
  }

  toolCopiesOf(catalogId: string, epoch: number) {
    return this.dependencies.manager
      .listTools({ serverId: sdkIdOf(catalogId, epoch) })
      .map(toolCopyOf);
  }

  async callTool(
    entry: McpCatalogEntry,
    ownerId: string,
    { request, epoch }: AdmittedCall
  ): Promise<McpCallOutcome> {
    const calledSdkId = sdkIdOf(request.catalogId, epoch);
    if (this.epochOf(request.catalogId) !== epoch) {
      return { _tag: "Failed", reason: "not_connected" };
    }
    try {
      if (
        (await this.ensureConnected(entry, ownerId, {
          timeoutMillis: request.connectTimeoutMillis,
          epoch,
        })) === "timed_out"
      ) {
        return { _tag: "Failed", reason: "timed_out" };
      }
    } catch {
      return { _tag: "Failed", reason: "failed" };
    }
    if (this.epochOf(request.catalogId) !== epoch) {
      return { _tag: "Failed", reason: "not_connected" };
    }
    return this.callConnected(request, calledSdkId);
  }

  private async callConnected(
    request: AdmittedCall["request"],
    calledSdkId: string
  ): Promise<McpCallOutcome> {
    try {
      const result = await within(
        this.dependencies.manager.callTool(
          {
            serverId: calledSdkId,
            name: request.tool,
            arguments: { ...request.arguments },
          },
          { timeout: request.callTimeoutMillis }
        ),
        request.callTimeoutMillis
      );
      if (Option.isNone(result)) {
        this.servers.retire(request.catalogId, calledSdkId);
        return { _tag: "Failed", reason: "timed_out" };
      }
      return resultOutcomeOf(result.value);
    } catch (error) {
      this.retireAtDeadline(request.catalogId, calledSdkId, error);
      return { _tag: "Failed", reason: "failed" };
    }
  }
}
