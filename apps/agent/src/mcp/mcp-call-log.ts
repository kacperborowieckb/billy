import { Effect } from "effect";

import { failureReasonOf, logMcpFailure } from "./mcp-failure.ts";
import type { McpCallOutcome, McpCallRequest } from "./mcp-hub-contract.ts";
import { loggedToolNameOf } from "./mcp-logged-name.ts";

const outcomeNameOf = (outcome: McpCallOutcome) => {
  if (outcome._tag === "Failed") {
    return outcome.reason;
  }
  return outcome.isError ? "service_error" : "result";
};

export const logMcpCall = (
  { catalogId, tool }: McpCallRequest,
  outcome: McpCallOutcome,
  durationMillis: number
) =>
  Effect.runPromise(
    Effect.logInfo(
      "MCP call",
      JSON.stringify({
        catalogId,
        tool: loggedToolNameOf(tool),
        outcome: outcomeNameOf(outcome),
        durationMillis,
        ...(outcome._tag === "Result"
          ? { resultCharacters: outcome.text.length }
          : {}),
      })
    )
  );

export const logMcpCallError = (
  { catalogId, tool }: McpCallRequest,
  error: unknown
) =>
  logMcpFailure({
    phase: "call",
    reason: failureReasonOf(error),
    catalogId,
    tool: loggedToolNameOf(tool),
  });
