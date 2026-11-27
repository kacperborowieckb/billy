import { Option, Schema } from "effect";

import { base64UrlOf, bytesOfBase64 } from "./base64-url.ts";

const nonceBytes = 12;
const sealedVersion = "v1";

export class SealFailedError extends Error {
  override readonly name = "SealFailedError";
}

export interface SealKey {
  readonly id: string;
  readonly key: CryptoKey;
}

export interface SealKeyring {
  readonly current: SealKey;
  readonly byId: ReadonlyMap<string, CryptoKey>;
}

const importKey = (text: string) =>
  crypto.subtle.importKey(
    "raw",
    bytesOfBase64(text),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );

const SealKeyEntrySchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[\w-]{1,32}:[A-Za-z\d+/]{43}=$/u))
);

const SealedRecordSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^v1\.[\w-]{1,32}\.[\w-]+\.[\w-]+$/u))
);

const decodeKeyEntry = Schema.decodeUnknownOption(SealKeyEntrySchema);
const decodeSealedRecord = Schema.decodeUnknownOption(SealedRecordSchema);

const parseKeyEntry = async (entry: string): Promise<SealKey> => {
  const checked = decodeKeyEntry(entry);
  if (Option.isNone(checked)) {
    throw new SealFailedError(
      "A sealing key must be <key id>:<base64 of 32 bytes>"
    );
  }
  const separator = checked.value.indexOf(":");
  return {
    id: checked.value.slice(0, separator),
    key: await importKey(checked.value.slice(separator + 1)),
  };
};

export const parseSealKeyring = async (
  secret: string
): Promise<SealKeyring> => {
  const entries = secret
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const keys = await Promise.all(entries.map(parseKeyEntry));
  const [current] = keys;
  if (current === undefined) {
    throw new SealFailedError("The sealing key list is empty");
  }
  const byId = new Map(keys.map(({ id, key }) => [id, key]));
  if (byId.size !== keys.length) {
    throw new SealFailedError("A sealing key id is listed twice");
  }
  return { current, byId };
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const sealingContextOf = (
  ownerId: string,
  catalogId: string,
  purpose: string
) =>
  JSON.stringify(["billy-mcp-hub", sealedVersion, ownerId, catalogId, purpose]);

export const seal = async (
  keyring: SealKeyring,
  plaintext: string,
  context: string
) => {
  const nonce = crypto.getRandomValues(new Uint8Array(nonceBytes));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: encoder.encode(context),
    },
    keyring.current.key,
    encoder.encode(plaintext)
  );
  return [
    sealedVersion,
    keyring.current.id,
    base64UrlOf(nonce),
    base64UrlOf(new Uint8Array(encrypted)),
  ].join(".");
};

export const open = async (
  keyring: SealKeyring,
  sealed: string,
  context: string
) => {
  const [, keyId = "", nonce = "", encrypted = ""] = sealed.split(".");
  const key = keyring.byId.get(keyId);
  if (Option.isNone(decodeSealedRecord(sealed)) || key === undefined) {
    throw new SealFailedError("The sealed record cannot be opened");
  }
  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytesOfBase64(nonce),
        additionalData: encoder.encode(context),
      },
      key,
      bytesOfBase64(encrypted)
    );
    return decoder.decode(decrypted);
  } catch {
    throw new SealFailedError("The sealed record cannot be opened");
  }
};
