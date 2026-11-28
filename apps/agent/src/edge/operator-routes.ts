import { Effect, Schema } from "effect";

import { defaultBehaviorConfig } from "../behavior/behavior-config.ts";
import { telegramIdentity } from "../directory/channel-identity.ts";
import { Directory } from "../directory/directory.ts";
import { OwnerIdSchema } from "../owner-id.ts";
import { personalAgentFor } from "../personal-agent/personal-agent.ts";
import {
  AddMcpConnectionRequestSchema,
  AddOwnerRequestSchema,
} from "./operator-contract.ts";
import type { AddOwnerResponse } from "./operator-contract.ts";
import { bearerToken, matchesSecret } from "./secret.ts";

const json = (status: number, body: unknown) => Response.json(body, { status });

export const handleAddOwner = (request: Request, env: Env) =>
  Effect.gen(function* handleAddOwnerEffect() {
    if (!matchesSecret(bearerToken(request), env.OPERATOR_TOKEN)) {
      return new Response(null, { status: 401 });
    }
    const body = yield* Effect.tryPromise(() => request.json<unknown>()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AddOwnerRequestSchema)),
      Effect.option
    );
    if (body._tag === "None") {
      return json(400, {
        error: "Send a JSON body with a positive integer telegramUserId.",
      });
    }
    const directory = yield* Directory;
    const channelIdentity = telegramIdentity(body.value.telegramUserId);
    return yield* directory.addOwner(channelIdentity).pipe(
      Effect.flatMap((ownerId) =>
        directory.registrationState.pipe(
          Effect.map((registration) =>
            json(201, {
              ownerId,
              channelIdentity,
              registration,
            } satisfies AddOwnerResponse)
          )
        )
      ),
      Effect.catchTag("ChannelIdentityTaken", () =>
        Effect.succeed(
          json(409, {
            error: `${channelIdentity} already belongs to an Owner.`,
          })
        )
      )
    );
  });

export const handleAddMcpConnection = (request: Request, env: Env) =>
  Effect.gen(function* handleAddMcpConnectionEffect() {
    if (!matchesSecret(bearerToken(request), env.OPERATOR_TOKEN)) {
      return new Response(null, { status: 401 });
    }
    const body = yield* Effect.tryPromise(() => request.json<unknown>()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AddMcpConnectionRequestSchema)),
      Effect.option
    );
    if (body._tag === "None") {
      return json(400, {
        error: "Send a JSON body with an ownerId and a catalogId.",
      });
    }
    const answer = yield* Effect.tryPromise(() =>
      env.MCP_HUB.getByName(body.value.ownerId).addConnection(
        body.value.catalogId,
        defaultBehaviorConfig.mcpConnectTimeoutMillis
      )
    ).pipe(Effect.option);
    if (answer._tag === "None") {
      return json(502, { error: "The MCP Hub did not answer." });
    }
    const { outcome } = answer.value;
    switch (outcome) {
      case "added": {
        return json(201, { catalogId: body.value.catalogId });
      }
      case "unknown_catalog_entry": {
        return json(404, { error: "The MCP Catalog has no such entry." });
      }
      case "failed": {
        return json(502, { error: "The MCP server did not connect." });
      }
      default: {
        return outcome satisfies never;
      }
    }
  });

export const handleRefreshMcpConnection = (request: Request, env: Env) =>
  Effect.gen(function* handleRefreshMcpConnectionEffect() {
    if (!matchesSecret(bearerToken(request), env.OPERATOR_TOKEN)) {
      return new Response(null, { status: 401 });
    }
    const body = yield* Effect.tryPromise(() => request.json<unknown>()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AddMcpConnectionRequestSchema)),
      Effect.option
    );
    if (body._tag === "None") {
      return json(400, {
        error: "Send a JSON body with an ownerId and a catalogId.",
      });
    }
    const { ownerId, catalogId } = body.value;
    const hub = env.MCP_HUB.getByName(ownerId);
    const answer = yield* Effect.tryPromise(async () => ({
      refreshed: await hub.refreshToolCatalog(
        catalogId,
        defaultBehaviorConfig.mcpConnectTimeoutMillis
      ),
      lastError: await hub.lastError(catalogId),
    })).pipe(Effect.option);
    if (answer._tag === "None") {
      return json(502, { error: "The MCP Hub did not answer." });
    }
    const { outcome } = answer.value.refreshed;
    const report = { outcome, lastError: answer.value.lastError ?? null };
    if (outcome !== "refreshed") {
      return json(200, report);
    }
    const tools = yield* Effect.tryPromise(async () => {
      const agent = await personalAgentFor(
        env.PERSONAL_AGENT,
        OwnerIdSchema.make(ownerId)
      );
      return await agent.mcpToolDefinitions(catalogId);
    }).pipe(Effect.option);
    return tools._tag === "None"
      ? json(502, { error: "The Personal Agent did not answer." })
      : json(200, { ...report, tools: tools.value });
  });
