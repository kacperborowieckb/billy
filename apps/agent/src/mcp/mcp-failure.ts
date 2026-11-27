import { Effect } from "effect";

import { isDeadlineError } from "./mcp-deadline-error.ts";

const knownCauses = [
  { pattern: /too many SQL variables/iu, reason: "sql_too_many_parameters" },
  {
    pattern: /could not determine its Durable Object name/iu,
    reason: "durable_object_has_no_name",
  },
  {
    pattern: /SQLITE_TOOBIG|string or blob too big/iu,
    reason: "sql_value_too_large",
  },
] as const;

const maxCauseDepth = 8;

const causeKeys = ["cause", "reason", "reasons", "error", "defect"] as const;

const safeNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,59}$/u;

const memberOf = (value: object, key: string): unknown =>
  key in value ? (value as Record<string, unknown>)[key] : undefined;

const causesOf = (error: unknown, depth = 0): readonly object[] => {
  if (typeof error !== "object" || error === null || depth >= maxCauseDepth) {
    return [];
  }
  if (Array.isArray(error)) {
    return error.flatMap((item) => causesOf(item, depth + 1));
  }
  return [
    error,
    ...causeKeys.flatMap((key) => causesOf(memberOf(error, key), depth + 1)),
  ];
};

const nameOf = (error: object) =>
  [memberOf(error, "_tag"), memberOf(error, "name")].find(
    (name): name is string =>
      typeof name === "string" && safeNamePattern.test(name)
  );

export const failureReasonOf = (error: unknown) => {
  const causes = causesOf(error);
  const known = knownCauses.find(({ pattern }) =>
    causes.some((cause) => pattern.test(String(memberOf(cause, "message"))))
  );
  if (known !== undefined) {
    return known.reason;
  }
  if (isDeadlineError(error)) {
    return "deadline";
  }
  const names = causes.map(nameOf).filter((name) => name !== undefined);
  return names.length === 0 ? "unknown" : names.join("/");
};

export type McpFailurePhase =
  | "start"
  | "callback"
  | "token_exchange"
  | "connect"
  | "completion"
  | "call";

export interface McpFailure {
  readonly phase: McpFailurePhase;
  readonly reason: string;
  readonly catalogId?: string;
  readonly httpStatus?: number;
  readonly toolCount?: number;
  readonly toolCopyCharacters?: number;
  readonly tool?: string;
}

export const mcpFailureLog = (failure: McpFailure) =>
  Effect.logWarning("MCP failure", JSON.stringify(failure));

export const logMcpFailure = (failure: McpFailure) =>
  Effect.runPromise(mcpFailureLog(failure));

export const toolCopySizeOf = (tools: readonly unknown[]) => ({
  toolCount: tools.length,
  toolCopyCharacters: JSON.stringify(tools).length,
});
