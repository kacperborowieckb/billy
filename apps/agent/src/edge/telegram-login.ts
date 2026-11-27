import { Clock, Effect, Option, Schema } from "effect";

const encoder = new TextEncoder();

const loginMaxAgeSeconds = 10 * 60;
const clockSkewSeconds = 60;

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const unsignedFields = new Set(["hash", "c", "r"]);

export const loginFieldsOf = (params: URLSearchParams) =>
  [...params.entries()].filter(([name]) => !unsignedFields.has(name));

const dataCheckStringOf = (fields: readonly (readonly [string, string])[]) =>
  fields
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");

const signatureOf = async (botToken: string, dataCheckString: string) => {
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
  return hex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(dataCheckString))
  );
};

const sameText = (left: string, right: string) => {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(leftBytes, rightBytes);
};

export type TelegramLogin =
  | { readonly _tag: "Verified"; readonly telegramUserId: number }
  | {
      readonly _tag: "Refused";
      readonly reason: "bad_signature" | "stale_login" | "malformed";
    };

const LoginFieldsSchema = Schema.Struct({
  id: Schema.NumberFromString.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThan(0))
  ),
  auth_date: Schema.NumberFromString.pipe(Schema.check(Schema.isInt())),
  hash: Schema.String,
});

const decodeLoginFields = Schema.decodeUnknownOption(LoginFieldsSchema);

export const verifyTelegramLogin = Effect.fnUntraced(
  function* verifyTelegramLogin(params: URLSearchParams, botToken: string) {
    const fields = decodeLoginFields(Object.fromEntries(params));
    if (Option.isNone(fields)) {
      return { _tag: "Refused", reason: "malformed" } satisfies TelegramLogin;
    }
    const { id, auth_date: authDate, hash: presented } = fields.value;
    const expected = yield* Effect.promise(() =>
      signatureOf(botToken, dataCheckStringOf(loginFieldsOf(params)))
    );
    if (!sameText(presented.toLowerCase(), expected)) {
      return {
        _tag: "Refused",
        reason: "bad_signature",
      } satisfies TelegramLogin;
    }
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const age = nowSeconds - authDate;
    if (age > loginMaxAgeSeconds || age < -clockSkewSeconds) {
      return { _tag: "Refused", reason: "stale_login" } satisfies TelegramLogin;
    }
    return { _tag: "Verified", telegramUserId: id } satisfies TelegramLogin;
  }
);
