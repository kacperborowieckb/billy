import { Effect, Option } from "effect";

import { telegramIdentity } from "../directory/channel-identity.ts";
import { Directory } from "../directory/directory.ts";
import type { OwnerId } from "../owner-id.ts";
import { loginFieldsOf, verifyTelegramLogin } from "./telegram-login.ts";

const pageHeaders = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
};

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const page = (status: number, title: string, body: string) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}button{font-size:1rem;padding:.6rem 1.2rem}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    { status, headers: pageHeaders }
  );

export const connectRefusedPage = () =>
  page(
    403,
    "This link did not work",
    "<p>Open the connect button in your chat with the agent again. If it still fails, ask the agent to connect the service once more.</p>"
  );

const notAvailablePage = () =>
  page(
    502,
    "Not available",
    "<p>The service could not be reached. Try again later.</p>"
  );

const alreadyConnectedPage = () =>
  page(200, "Already connected", "<p>This service is already connected.</p>");

const unknownServicePage = () =>
  page(404, "Unknown service", "<p>This service is not supported.</p>");

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

const ownerOfLogin = (params: URLSearchParams, env: Env) =>
  Effect.gen(function* ownerOfLoginEffect() {
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
      Option.map(({ ownerId }) => ownerId)
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
  ]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name ?? "")}" value="${escapeHtml(value ?? "")}">`
    )
    .join("");
  return page(
    200,
    `Connect ${consent.serverName}`,
    `<p>The agent will connect to <strong>${escapeHtml(consent.serverName)}</strong>.</p><ul><li>Sign-in happens at: ${escapeHtml(consent.authorizationServer)}</li><li>Client mode: ${escapeHtml(consent.clientMode)}</li></ul><form method="post" action="/mcp/connect">${hidden}<button type="submit">Continue</button></form>`
  );
};

export const handleMcpConnect = (request: Request, env: Env) =>
  Effect.gen(function* handleMcpConnectEffect() {
    const params = yield* paramsOf(request);
    const ownerId = yield* ownerOfLogin(params, env);
    const catalogId = params.get("c") ?? "";
    if (Option.isNone(ownerId)) {
      return connectRefusedPage();
    }
    const hub = env.MCP_HUB.getByName(ownerId.value);
    const oauthRequest = oauthRequestOf(request, catalogId);
    if (request.method === "GET") {
      const consent = yield* Effect.tryPromise(
        async () => await hub.describeConsent(oauthRequest)
      ).pipe(Effect.option);
      if (Option.isNone(consent)) {
        return notAvailablePage();
      }
      switch (consent.value.outcome) {
        case "ready_to_consent": {
          return consentPage(params, consent.value);
        }
        case "already_connected": {
          return alreadyConnectedPage();
        }
        case "unknown_catalog_entry": {
          return unknownServicePage();
        }
        default: {
          return notAvailablePage();
        }
      }
    }
    const started = yield* Effect.tryPromise(
      async () => await hub.startOAuth(oauthRequest)
    ).pipe(Effect.option);
    if (Option.isNone(started)) {
      return notAvailablePage();
    }
    switch (started.value.outcome) {
      case "redirect": {
        return new Response(null, {
          status: 303,
          headers: {
            Location: started.value.authorizationUrl,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
      case "already_connected": {
        return alreadyConnectedPage();
      }
      case "unknown_catalog_entry": {
        return unknownServicePage();
      }
      default: {
        return notAvailablePage();
      }
    }
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
