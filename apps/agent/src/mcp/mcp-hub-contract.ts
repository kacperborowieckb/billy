import { Context } from "effect";
import type { Effect } from "effect";

export interface McpCallRequest {
  readonly catalogId: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly connectTimeoutMillis: number;
  readonly callTimeoutMillis: number;
}

export type McpCallOutcome =
  | {
      readonly _tag: "Result";
      readonly isError: boolean;
      readonly text: string;
      readonly structured: unknown;
    }
  | {
      readonly _tag: "Failed";
      readonly reason: "timed_out" | "failed" | "not_connected";
    };

export interface McpAddConnectionOutcome {
  readonly outcome: "added" | "unknown_catalog_entry" | "failed";
}

export interface McpHubRpc {
  readonly addConnection: (
    catalogId: string,
    connectTimeoutMillis: number
  ) => Promise<McpAddConnectionOutcome>;
  readonly callTool: (request: McpCallRequest) => Promise<McpCallOutcome>;
}

export class McpHubPort extends Context.Service<
  McpHubPort,
  {
    readonly callTool: (
      request: McpCallRequest
    ) => Effect.Effect<McpCallOutcome>;
  }
>()("McpHubPort") {}
