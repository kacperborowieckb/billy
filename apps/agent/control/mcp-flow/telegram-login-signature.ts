import { createHash, createHmac } from "node:crypto";

export const signedTelegramLogin = (
  fields: Readonly<Record<string, string>>,
  botToken: string
) => {
  const dataCheckString = Object.entries(fields)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  const key = createHash("sha256").update(botToken).digest();
  const hash = createHmac("sha256", key).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...fields, hash });
};
