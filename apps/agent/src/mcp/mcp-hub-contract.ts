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

export interface McpOAuthRequest {
  readonly catalogId: string;
  readonly redirectUrl: string;
  readonly clientMetadataUrl: string | undefined;
  readonly proofId: string;
}

export type McpConsentOutcome =
  | {
      readonly outcome: "ready_to_consent";
      readonly serverName: string;
      readonly authorizationServer: string;
      readonly clientMode: "CIMD" | "DCR";
    }
  | {
      readonly outcome:
        | "unknown_catalog_entry"
        | "already_connected"
        | "unavailable";
    };

export type McpOAuthStartOutcome =
  | { readonly outcome: "redirect"; readonly authorizationUrl: string }
  | {
      readonly outcome:
        | "unknown_catalog_entry"
        | "already_connected"
        | "proof_used"
        | "unavailable";
    };

export interface McpOAuthCallback {
  readonly nonce: string;
  readonly code: string | undefined;
  readonly iss: string | undefined;
  readonly error: string | undefined;
}

export type McpCallbackOutcome =
  | { readonly outcome: "connected"; readonly serverName: string }
  | {
      readonly outcome: "denied" | "failed" | "already_connected";
      readonly serverName: string;
    }
  | { readonly outcome: "not_started" };

export interface McpHubRpc {
  readonly describeConsent: (
    request: McpOAuthRequest
  ) => Promise<McpConsentOutcome>;
  readonly startOAuth: (
    request: McpOAuthRequest
  ) => Promise<McpOAuthStartOutcome>;
  readonly completeOAuth: (
    callback: McpOAuthCallback
  ) => Promise<McpCallbackOutcome>;
  readonly addConnection: (
    catalogId: string,
    connectTimeoutMillis: number
  ) => Promise<McpAddConnectionOutcome>;
  readonly callTool: (request: McpCallRequest) => Promise<McpCallOutcome>;
}

export class McpHubPort extends Context.Service<
  McpHubPort,
  {
    readonly routingId: string;
    readonly callTool: (
      request: McpCallRequest
    ) => Effect.Effect<McpCallOutcome>;
  }
>()("McpHubPort") {}
