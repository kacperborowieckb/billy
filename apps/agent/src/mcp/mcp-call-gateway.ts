import type { KeyedQueue } from "./keyed-queue.ts";
import { mcpEntryOf } from "./mcp-catalog.ts";
import type { McpCatalog } from "./mcp-catalog.ts";
import type { McpConnectionLedger } from "./mcp-connection-ledger.ts";
import type { McpCallOutcome, McpCallRequest } from "./mcp-hub-contract.ts";
import type { McpServerConnector } from "./mcp-server-connector.ts";

export interface McpCallGatewayDependencies {
  readonly catalog: McpCatalog;
  readonly entryQueue: KeyedQueue;
  readonly ledger: McpConnectionLedger;
  readonly connector: McpServerConnector;
  readonly ownerId: () => string;
  readonly tellNeedsSignIn: (
    ownerId: string,
    catalogId: string
  ) => Promise<void>;
}

export class McpCallGateway {
  private readonly dependencies: McpCallGatewayDependencies;

  constructor(dependencies: McpCallGatewayDependencies) {
    this.dependencies = dependencies;
  }

  private signInFailure(catalogId: string): Promise<McpCallOutcome> {
    const { entryQueue, ledger, tellNeedsSignIn, ownerId } = this.dependencies;
    return entryQueue.run(catalogId, async (): Promise<McpCallOutcome> => {
      if ((await ledger.stateOf(catalogId)) !== "needs_sign_in") {
        return { _tag: "Failed", reason: "failed" };
      }
      await tellNeedsSignIn(ownerId(), catalogId);
      const lastError = await ledger.lastErrorOf(catalogId);
      return {
        _tag: "Failed",
        reason:
          lastError?.reason === "insufficient_scope"
            ? "insufficient_scope"
            : "needs_sign_in",
      };
    });
  }

  async callTool(request: McpCallRequest): Promise<McpCallOutcome> {
    const { catalog, ledger, connector, ownerId } = this.dependencies;
    const epoch = connector.epochOf(request.catalogId);
    const entry = mcpEntryOf(catalog, request.catalogId);
    const state =
      entry === undefined ? undefined : await ledger.stateOf(request.catalogId);
    if (entry === undefined || state === undefined) {
      return { _tag: "Failed", reason: "not_connected" };
    }
    if (state === "needs_sign_in") {
      return this.signInFailure(request.catalogId);
    }
    const outcome = await connector.callTool(entry, ownerId(), {
      request,
      epoch,
    });
    if (outcome._tag === "Result") {
      return outcome;
    }
    const stateAfter = await ledger.stateOf(request.catalogId);
    if (stateAfter === undefined) {
      return { _tag: "Failed", reason: "not_connected" };
    }
    return stateAfter === "needs_sign_in"
      ? this.signInFailure(request.catalogId)
      : outcome;
  }
}
