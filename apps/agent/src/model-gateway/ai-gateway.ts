import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import { Effect, Layer, Schema } from "effect";

import type { OwnerId } from "../owner-id.ts";
import { sha256Hex } from "../sha256-hex.ts";
import { ModelProvider } from "./model-provider.ts";
import { routeOf } from "./model-routes.ts";
import type { ModelRouteTable } from "./model-routes.ts";

export interface AiGatewayConfig {
  readonly url: string;
  readonly gatewayId: string;
  readonly routes: ModelRouteTable;
  readonly fetch?: typeof fetch;
}

export const BillingModeSchema = Schema.Literals(["unified-billing", "byok"]);

export type BillingMode = typeof BillingModeSchema.Type;

export interface ModelCredentials {
  readonly token: string;
  readonly billing: BillingMode;
}

const providerName = "cloudflare-ai-gateway";

const billingHeaders = (billing: BillingMode): Record<string, string> =>
  billing === "byok" ? { "cf-aig-no-wholesale": "true" } : {};

export const sessionAffinityOf = (ownerId: OwnerId) =>
  sha256Hex(`session-affinity:${ownerId}`);

export interface OwnerSession {
  readonly ownerId: OwnerId;
  readonly sessionAffinity: string;
}

export const aiGatewayHeaders = (
  gatewayId: string,
  credentials: ModelCredentials,
  { ownerId, sessionAffinity }: OwnerSession
): Record<string, string> => ({
  "cf-aig-gateway-id": gatewayId,
  "cf-aig-metadata": JSON.stringify({ ownerId }),
  "cf-aig-collect-log-payload": "false",
  "cf-aig-skip-cache": "true",
  "x-session-affinity": sessionAffinity,
  ...billingHeaders(credentials.billing),
});

export const aiGatewayModelProvider = (
  config: AiGatewayConfig,
  credentials: ModelCredentials,
  ownerId: OwnerId
) =>
  Layer.effect(
    ModelProvider,
    Effect.map(sessionAffinityOf(ownerId), (sessionAffinity) => {
      const provider = createOpenAICompatible({
        name: providerName,
        baseURL: config.url,
        apiKey: credentials.token,
        headers: aiGatewayHeaders(config.gatewayId, credentials, {
          ownerId,
          sessionAffinity,
        }),
        includeUsage: true,
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      });
      return {
        route: (task) => {
          const { model, reasoningEffort } = routeOf(config.routes, task);
          return {
            reasoningEffort,
            model: wrapLanguageModel({
              model: provider.chatModel(model),
              middleware: defaultSettingsMiddleware({
                settings: {
                  providerOptions: { [providerName]: { reasoningEffort } },
                },
              }),
            }),
          };
        },
      };
    })
  );
