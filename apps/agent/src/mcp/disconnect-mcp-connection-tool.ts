import { Effect, Schema } from "effect";

import type { ApprovalRunOutcome } from "../approval/approval-answering.ts";
import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import type { McpCatalogEntry } from "./mcp-catalog.ts";
import type { McpRevocation } from "./mcp-hub-contract.ts";
import { disconnectMcpConnectionToolName } from "./mcp-tool-names.ts";
import {
  connectionDescription,
  entryOrFail,
  stateOrFail,
} from "./mcp-tool-services.ts";
import type { McpToolServices } from "./mcp-tool-services.ts";

const DisconnectMcpConnectionInput = Schema.Struct({
  connection: Schema.String.pipe(
    Schema.annotate({ description: connectionDescription })
  ),
});

const DisconnectOutputSchema = Schema.Struct({
  connection: Schema.String,
  status: Schema.Literal("disconnected"),
  notice: Schema.String,
});

type DisconnectOutput = typeof DisconnectOutputSchema.Type;

const noticeOf = (displayName: string, revocation: McpRevocation) => {
  const base = `${displayName} is disconnected. The agent has no access to it now, and its tokens are deleted here.`;
  if (revocation === "failed") {
    return `${base} The service did not confirm that it revoked the token. Tell the Owner that they can remove Billy in the settings of ${displayName}.`;
  }
  return base;
};

const approvedRunOutcomeOf = (
  output: DisconnectOutput
): ApprovalRunOutcome => ({
  result: "executed",
  output,
});

export const disconnectMcpConnectionTool = (
  services: McpToolServices,
  eventId: string
) =>
  recordedTool<
    typeof DisconnectMcpConnectionInput.Type,
    DisconnectOutput,
    ToolFailed,
    McpCatalogEntry
  >(
    { eventId, progress: services.progress, redactor: services.redactor },
    {
      name: disconnectMcpConnectionToolName,
      description:
        "Disconnect a connected service (an MCP Connection): the token is revoked at the service where possible, and the tokens and the tool copy are deleted. It needs the Owner's Approval when this Turn read Untrusted Content.",
      inputSchema: DisconnectMcpConnectionInput,
      riskClass: "change",
      resolve: Effect.fnUntraced(function* resolveDisconnect({ connection }) {
        const entry = yield* entryOrFail(services.catalog, connection);
        yield* stateOrFail(services, entry);
        return entry;
      }),
      approvalSummary: (entry) => `Disconnect ${entry.displayName}`,
      hasExternalEffect: true as const,
      approvedRunOutcomeOf,
      failureMessage:
        "The disconnect did not finish. Tell the Owner that it failed.",
      work: Effect.fnUntraced(function* disconnectWork(entry) {
        const outcome = yield* services.hub.disconnect(entry.catalogId);
        if (outcome.outcome !== "disconnected") {
          return yield* Effect.fail(
            new ToolFailed({
              message: `The disconnect of ${entry.displayName} did not finish. Tell the Owner that it is not confirmed and that they can ask again.`,
            })
          );
        }
        yield* services.removeConnection(entry.catalogId, outcome.revocation);
        return {
          connection: entry.displayName,
          status: "disconnected" as const,
          notice: noticeOf(entry.displayName, outcome.revocation),
        };
      }),
    }
  );
