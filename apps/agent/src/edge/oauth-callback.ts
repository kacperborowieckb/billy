import { Effect, Option } from "effect";

import type { McpCallbackOutcome } from "../mcp/mcp-hub-contract.ts";
import {
  connectRefusedPage,
  escapeHtml,
  notAvailablePage,
  page,
} from "./pages.ts";

const routingIdPattern = /^[\da-f]{64}$/u;

const parameterLimit = 2048;

const bounded = (value: string | null) =>
  value === null || value.length > parameterLimit ? undefined : value;

const hubOf = (env: Env, routingId: string) => {
  if (!routingIdPattern.test(routingId)) {
    return Option.none();
  }
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
    const query = new URL(request.url).searchParams;
    const state = bounded(query.get("state")) ?? "";
    const separator = state.indexOf(".");
    const nonce = state.slice(separator + 1);
    const hub =
      separator === -1 || nonce.length === 0
        ? Option.none()
        : hubOf(env, state.slice(0, separator));
    if (Option.isNone(hub)) {
      return connectRefusedPage();
    }
    const outcome = yield* Effect.tryPromise(
      async () =>
        await hub.value.completeOAuth({
          nonce,
          code: bounded(query.get("code")),
          iss: bounded(query.get("iss")),
          error: bounded(query.get("error")),
        })
    ).pipe(Effect.option);
    return Option.isNone(outcome) ? notAvailablePage() : pageFor(outcome.value);
  }
);
