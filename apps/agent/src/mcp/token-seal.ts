import { base64UrlOf, bytesOfBase64 } from "./base64-url.ts";

const keyBytes = 32;
const nonceBytes = 12;
const sealedVersion = "v1";
const keyIdPattern = /^[\w-]{1,32}$/u;

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

const parseKeyEntry = async (entry: string): Promise<SealKey> => {
  const separator = entry.indexOf(":");
  const id = entry.slice(0, separator);
  const material = entry.slice(separator + 1);
  if (
    separator === -1 ||
    !keyIdPattern.test(id) ||
    bytesOfBase64(material).byteLength !== keyBytes
  ) {
    throw new SealFailedError(
      "A sealing key must be <key id>:<base64 of 32 bytes>"
    );
  }
  return { id, key: await importKey(material) };
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
  return {
    current,
    byId: new Map(keys.map(({ id, key }) => [id, key])),
  };
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
  const [version, keyId, nonce, encrypted] = sealed.split(".");
  const key = keyId === undefined ? undefined : keyring.byId.get(keyId);
  if (
    version !== sealedVersion ||
    key === undefined ||
    nonce === undefined ||
    encrypted === undefined
  ) {
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
