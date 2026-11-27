import { Effect, Option } from "effect";

import { telegramIdentity } from "../directory/channel-identity.ts";
import { Directory } from "../directory/directory.ts";
import type { OwnerId } from "../owner-id.ts";
import {
  alreadyConnectedPage,
  connectRefusedPage,
  continuePage,
  escapeHtml,
  notAvailablePage,
  page,
  unknownServicePage,
} from "./pages.ts";
import { loginFieldsOf, verifyTelegramLogin } from "./telegram-login.ts";

export const callbackPath = "/oauth/callback";
export const clientMetadataPath = "/oauth/client-metadata.json";

const oauthRequestOf = (request: Request, catalogId: string) => {
  const { origin, protocol } = new URL(request.url);
  return {
    catalogId,
    redirectUrl: `${origin}${callbackPath}`,
    clientMetadataUrl:
      protocol === "https:" ? `${origin}${clientMetadataPath}` : undefined,
  };
};

const paramsOf = (request: Request) =>
  request.method === "POST"
    ? Effect.tryPromise(() => request.formData()).pipe(
        Effect.map(
          (form) =>
            new URLSearchParams(
              [...form.entries()].flatMap(([name, value]) =>
                typeof value === "string" ? [[name, value]] : []
              )
            )
        ),
        Effect.orElseSucceed(() => new URLSearchParams())
      )
    : Effect.succeed(new URLSearchParams(new URL(request.url).search));

const ownerOfLogin = Effect.fnUntraced(function* ownerOfLogin(
  params: URLSearchParams,
  env: Env
) {
  const login = yield* verifyTelegramLogin(params, env.TELEGRAM_BOT_TOKEN);
  if (login._tag === "Refused") {
    return Option.none<OwnerId>();
  }
  const directory = yield* Directory;
  const owner = yield* directory.findOwner(
    telegramIdentity(login.telegramUserId)
  );
  return owner.pipe(
    Option.filter(({ status }) => status === "active"),
    Option.map(({ ownerId }) => ownerId),
    Option.filter(
      (ownerId) =>
        env.MCP_HUB.idFromName(ownerId).toString() === params.get("r")
    )
  );
});

const consentPage = (
  params: URLSearchParams,
  consent: {
    readonly serverName: string;
    readonly authorizationServer: string;
    readonly clientMode: string;
  }
) => {
  const hidden = [
    ...loginFieldsOf(params),
    ["hash", params.get("hash") ?? ""],
    ["c", params.get("c") ?? ""],
    ["r", params.get("r") ?? ""],
  ]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name ?? "")}" value="${escapeHtml(value ?? "")}">`
    )
    .join("");
  return page(
    200,
    `Connect ${consent.serverName}`,
    `<p>Billy will connect to <strong>${escapeHtml(consent.serverName)}</strong>.</p><ul><li>Sign-in happens at: ${escapeHtml(consent.authorizationServer)}</li><li>Client mode: ${escapeHtml(consent.clientMode)}</li></ul><form method="post" action="/mcp/connect">${hidden}<button type="submit">Continue</button></form>`
  );
};

type RefusedOutcome =
  | "already_connected"
  | "unknown_catalog_entry"
  | "proof_used"
  | "unavailable";

const refusalPageFor = (outcome: RefusedOutcome) => {
  switch (outcome) {
    case "already_connected": {
      return alreadyConnectedPage();
    }
    case "unknown_catalog_entry": {
      return unknownServicePage();
    }
    case "proof_used": {
      return connectRefusedPage();
    }
    default: {
      return notAvailablePage();
    }
  }
};

export const handleMcpConnect = Effect.fnUntraced(function* handleMcpConnect(
  request: Request,
  env: Env
) {
  const params = yield* paramsOf(request);
  const ownerId = yield* ownerOfLogin(params, env);
  if (Option.isNone(ownerId)) {
    return connectRefusedPage();
  }
  const hub = env.MCP_HUB.getByName(ownerId.value);
  const oauthRequest = {
    ...oauthRequestOf(request, params.get("c") ?? ""),
    proofId: (params.get("hash") ?? "").toLowerCase(),
  };
  if (request.method === "GET") {
    const consent = yield* Effect.tryPromise(
      async () => await hub.describeConsent(oauthRequest)
    ).pipe(Effect.option);
    if (Option.isNone(consent)) {
      return notAvailablePage();
    }
    return consent.value.outcome === "ready_to_consent"
      ? consentPage(params, consent.value)
      : refusalPageFor(consent.value.outcome);
  }
  const started = yield* Effect.tryPromise(
    async () => await hub.startOAuth(oauthRequest)
  ).pipe(Effect.option);
  if (Option.isNone(started)) {
    return notAvailablePage();
  }
  return started.value.outcome === "started"
    ? continuePage(started.value.serverName, started.value.authorizationUrl)
    : refusalPageFor(started.value.outcome);
});

export const handleClientMetadata = (request: Request) =>
  Effect.sync(() => {
    const { origin, protocol } = new URL(request.url);
    if (protocol !== "https:") {
      return new Response("Not Found", { status: 404 });
    }
    return Response.json({
      client_id: `${origin}${clientMetadataPath}`,
      client_name: "Billy",
      redirect_uris: [`${origin}${callbackPath}`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });
