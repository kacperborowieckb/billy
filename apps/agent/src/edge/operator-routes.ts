import { Effect, Schema } from "effect";

import { defaultBehaviorConfig } from "../behavior/behavior-config.ts";
import { telegramIdentity } from "../directory/channel-identity.ts";
import { Directory } from "../directory/directory.ts";
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
