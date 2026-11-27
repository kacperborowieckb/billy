import { env, runInDurableObject } from "cloudflare:test";
import { DateTime } from "effect";

import { testMcpCatalogId } from "../src/mcp/mcp-test-catalog.ts";
import { sendToEdge } from "./telegram-requests.ts";

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const signedLogin = async (
  fields: Record<string, string>,
  botToken = env.TELEGRAM_BOT_TOKEN
) => {
  const dataCheckString = Object.entries(fields)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  const secret = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(botToken)
  );
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const hash = hex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(dataCheckString))
  );
  return new URLSearchParams({ ...fields, hash });
};

export const nowSeconds = () =>
  Math.floor(DateTime.toEpochMillis(DateTime.nowUnsafe()) / 1000);

export const loginOf = async (
  telegramUserId: number,
  ownerId: string,
  overrides: { authDate?: number; botToken?: string } = {}
) => {
  const params = await signedLogin(
    {
      id: String(telegramUserId),
      first_name: "Owner",
      auth_date: String(overrides.authDate ?? nowSeconds()),
    },
    overrides.botToken
  );
  params.set("c", testMcpCatalogId);
  params.set("r", env.MCP_HUB.idFromName(ownerId).toString());
  return params;
};

export const getConsent = (params: URLSearchParams) =>
  sendToEdge(new Request(`https://agent.test/mcp/connect?${params}`));

export const postConsent = (params: URLSearchParams) =>
  sendToEdge(
    new Request("https://agent.test/mcp/connect", {
      method: "POST",
      body: params,
    })
  );

export const pendingOAuthOf = (ownerId: string) =>
  runInDurableObject(env.MCP_HUB.getByName(ownerId), (_hub, state) =>
    state.storage.list({ prefix: "oauth:" })
  );

export const pendingOAuthCountOf = async (ownerId: string) => {
  const pending = await pendingOAuthOf(ownerId);
  return pending.size;
};
