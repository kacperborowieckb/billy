import { Effect, Option, Schema } from "effect";

import type { McpCallbackOutcome } from "../mcp/mcp-hub-contract.ts";
import {
  alreadyConnectedPage,
  connectRefusedPage,
  escapeHtml,
  notAvailablePage,
  page,
} from "./pages.ts";

const parameter = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(2048))
);

const CallbackQuerySchema = Schema.Struct({
  state: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[\da-f]{64}\.[\w-]{1,256}$/u))
  ),
  code: Schema.optionalKey(parameter),
  iss: Schema.optionalKey(parameter),
  error: Schema.optionalKey(parameter),
});

const decodeCallbackQuery = Schema.decodeUnknownOption(CallbackQuerySchema);

const hubOf = (env: Env, routingId: string) => {
  try {
    return Option.some(env.MCP_HUB.get(env.MCP_HUB.idFromString(routingId)));
  } catch {
    return Option.none();
  }
};

const pageFor = (outcome: McpCallbackOutcome) => {
  switch (outcome.outcome) {
    case "connected": {
      return page(
        200,
        `Connected ${outcome.serverName}`,
        `<p>${escapeHtml(outcome.serverName)} is connected. Go back to your chat with Billy.</p>`
      );
    }
    case "denied": {
      return page(
        200,
        "Not connected",
        `<p>The sign-in with ${escapeHtml(outcome.serverName)} did not finish. Ask Billy to connect it again if you want to.</p>`
      );
    }
    case "already_connected": {
      return alreadyConnectedPage();
    }
    case "failed": {
      return notAvailablePage();
    }
    default: {
      return connectRefusedPage();
    }
  }
};

export const handleOAuthCallback = Effect.fnUntraced(
  function* handleOAuthCallback(request: Request, env: Env) {
    const query = decodeCallbackQuery(
      Object.fromEntries(new URL(request.url).searchParams)
    );
    if (Option.isNone(query)) {
      return connectRefusedPage();
    }
    const { state, code, iss, error } = query.value;
    const [routingId = "", nonce = ""] = state.split(".");
    const hub = hubOf(env, routingId);
    if (Option.isNone(hub)) {
      return connectRefusedPage();
    }
    const outcome = yield* Effect.tryPromise(
      async () =>
        await hub.value.completeOAuth({
          nonce,
          code,
          iss,
          error,
        })
    ).pipe(Effect.option);
    return Option.isNone(outcome) ? notAvailablePage() : pageFor(outcome.value);
  }
);
