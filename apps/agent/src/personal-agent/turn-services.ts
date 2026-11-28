import { Data, Effect, Layer, Option, Schema } from "effect";

import { modelReviewerLayer } from "../auto-review/model-reviewer.ts";
import { telegramChannel } from "../channels/telegram/telegram-channel.ts";
import { mcpHubClient } from "../mcp/mcp-hub-client.ts";
import {
  aiGatewayModelProvider,
  BillingModeSchema,
} from "../model-gateway/ai-gateway.ts";
import { ModelGateway } from "../model-gateway/model-gateway.ts";
import { ModelRouteTableSchema } from "../model-gateway/model-routes.ts";
import type { OwnerId } from "../owner-id.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import { Redactor } from "../tracing/redactor.ts";

export class TurnConfigurationInvalid extends Data.TaggedError(
  "TurnConfigurationInvalid"
)<{ readonly names: readonly string[] }> {
  override get message() {
    return `The Worker configuration is missing or invalid for: ${this.names.join(", ")}`;
  }
}

const NonEmpty = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));
const HttpUrl = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^https?:\/\/\S+$/u))
);

const TurnEnvSchema = Schema.Struct({
  TELEGRAM_API_URL: HttpUrl,
  TELEGRAM_BOT_TOKEN: NonEmpty,
  AI_GATEWAY_URL: HttpUrl,
  AI_GATEWAY_ID: NonEmpty,
  AI_GATEWAY_TOKEN: NonEmpty,
  MODEL_ROUTES: ModelRouteTableSchema,
  MODEL_BILLING: BillingModeSchema,
});

export type TurnEnv = typeof TurnEnvSchema.Type;

const invalidNames = (env: Env) => {
  const values: Record<string, unknown> = { ...env };
  return Object.entries(TurnEnvSchema.fields)
    .filter(([name, schema]) =>
      Option.isNone(Schema.decodeUnknownOption(schema)(values[name]))
    )
    .map(([name]) => name);
};

export const decodeTurnEnv = (env: Env) =>
  Schema.decodeUnknownEffect(TurnEnvSchema)(env).pipe(
    Effect.mapError(
      () => new TurnConfigurationInvalid({ names: invalidNames(env) })
    )
  );

export const liveModelGateway = (config: TurnEnv, ownerId: OwnerId) =>
  ModelGateway.layer.pipe(
    Layer.provide(
      aiGatewayModelProvider(
        {
          url: config.AI_GATEWAY_URL,
          gatewayId: config.AI_GATEWAY_ID,
          routes: config.MODEL_ROUTES,
        },
        {
          token: config.AI_GATEWAY_TOKEN,
          billing: config.MODEL_BILLING,
        },
        ownerId
      )
    )
  );

export const liveTurnServices = (env: Env, ownerId: OwnerId) =>
  Layer.unwrap(
    Effect.map(decodeTurnEnv(env), (config) =>
      Layer.mergeAll(
        OperatorMetrics.layer(env.OPERATOR_METRICS),
        Redactor.layer([
          config.TELEGRAM_BOT_TOKEN,
          config.AI_GATEWAY_TOKEN,
          env.TELEGRAM_WEBHOOK_SECRET,
          env.OPERATOR_TOKEN,
        ]),
        telegramChannel({
          apiUrl: config.TELEGRAM_API_URL,
          botToken: config.TELEGRAM_BOT_TOKEN,
          edgeUrl: env.EDGE_PUBLIC_URL,
        }),
        modelReviewerLayer.pipe(
          Layer.provideMerge(liveModelGateway(config, ownerId))
        ),
        mcpHubClient(env.MCP_HUB, ownerId)
      )
    )
  );
