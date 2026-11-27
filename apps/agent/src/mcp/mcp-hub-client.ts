import { Effect, Layer } from "effect";

import type { OwnerId } from "../owner-id.ts";
import { McpHubPort } from "./mcp-hub-contract.ts";
import type { McpDisconnectOutcome } from "./mcp-hub-contract.ts";
import type { McpHub } from "./mcp-hub.ts";

export const mcpHubClient = (
  namespace: DurableObjectNamespace<McpHub>,
  ownerId: OwnerId
) =>
  Layer.succeed(McpHubPort, {
    routingId: namespace.idFromName(ownerId).toString(),
    callTool: (request) =>
      Effect.promise(() => namespace.getByName(ownerId).callTool(request)).pipe(
        Effect.catchCause(() =>
          Effect.succeed({ _tag: "Failed", reason: "failed" } as const)
        )
      ),
    disconnect: (catalogId) =>
      Effect.promise(
        async (): Promise<McpDisconnectOutcome> =>
          await namespace.getByName(ownerId).disconnect(catalogId)
      ).pipe(
        Effect.catchCause(() =>
          Effect.succeed<McpDisconnectOutcome>({ outcome: "failed" })
        )
      ),
  });
