import { Clock, Console, Effect } from "effect";

import { fakeOAuthSecrets } from "../fake-oauth-server.ts";
import { fakeNotionOrigin } from "./fake-notion.ts";
import { flowCheck } from "./flow-checks.ts";
import { signedTelegramLogin } from "./telegram-login-signature.ts";

export interface SignInOptions {
  readonly workerUrl: URL;
  readonly botToken: string;
  readonly telegramUserId: number;
  readonly buttonUrl: URL;
}

const request = (url: URL, init?: RequestInit) =>
  Effect.promise(async () => {
    const response = await fetch(url, { ...init, redirect: "manual" });
    return {
      status: response.status,
      location: response.headers.get("Location"),
      body: await response.text(),
    };
  });

const loginOf = ({ buttonUrl, botToken, telegramUserId }: SignInOptions) =>
  Effect.gen(function* loginEffect() {
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const login = signedTelegramLogin(
      {
        id: String(telegramUserId),
        first_name: "Owner",
        auth_date: String(nowSeconds),
      },
      botToken
    );
    for (const [name, value] of buttonUrl.searchParams) {
      login.set(name, value);
    }
    return login;
  });

export const signInThroughEdge = Effect.fnUntraced(function* signIn(
  options: SignInOptions
) {
  const { workerUrl, buttonUrl } = options;
  const login = yield* loginOf(options);
  const consentUrl = new URL(`${buttonUrl.pathname}?${login}`, workerUrl);
  const consent = yield* request(consentUrl);
  yield* flowCheck(
    "consent page",
    consent.status === 200 &&
      consent.body.includes("Billy will connect to") &&
      consent.body.includes(fakeNotionOrigin) &&
      consent.body.includes("DCR"),
    `${consent.status} ${consent.body}`
  );
  yield* Console.log(
    `Edge: consent page for Notion, sign-in at ${fakeNotionOrigin}, client mode DCR`
  );

  const started = yield* request(new URL(buttonUrl.pathname, workerUrl), {
    method: "POST",
    body: login,
  });
  const authorization = new URL(started.location ?? workerUrl);
  yield* flowCheck(
    "start of OAuth",
    started.status === 303 &&
      authorization.origin === fakeNotionOrigin &&
      authorization.searchParams.get("code_challenge_method") === "S256",
    `${started.status} ${started.location ?? ""}`
  );
  yield* Console.log(
    `Edge: 303 to ${authorization.origin}${authorization.pathname} with PKCE S256`
  );

  const callback = yield* request(
    new URL(
      `/oauth/callback?${new URLSearchParams({
        code: fakeOAuthSecrets.authorizationCode,
        state: authorization.searchParams.get("state") ?? "",
        iss: fakeNotionOrigin,
      })}`,
      workerUrl
    )
  );
  yield* flowCheck(
    "OAuth callback",
    callback.status === 200,
    `${callback.status} ${callback.body}`
  );
  yield* Console.log(`Edge: callback answered ${callback.status}`);
});
