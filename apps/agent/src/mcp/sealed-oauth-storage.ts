import { open, seal, SealFailedError } from "./token-seal.ts";
import type { SealKeyring } from "./token-seal.ts";

export interface SealedOAuthStorageInput {
  readonly storage: DurableObjectStorage;
  readonly keyring: SealKeyring;
  readonly ownerId: string;
}

const contextOf = (ownerId: string, key: string) =>
  JSON.stringify(["billy-mcp-oauth-storage", "v1", ownerId, key]);

class SealingStorage {
  private readonly input: SealedOAuthStorageInput;

  constructor(input: SealedOAuthStorageInput) {
    this.input = input;
  }

  private async unseal<Value>(key: string, sealed: string): Promise<Value> {
    const { keyring, ownerId } = this.input;
    return JSON.parse(
      await open(keyring, sealed, contextOf(ownerId, key))
    ) as Value;
  }

  async get<Value>(key: string): Promise<Value | undefined> {
    const sealed = await this.input.storage.get<string>(key);
    return sealed === undefined ? undefined : this.unseal<Value>(key, sealed);
  }

  async put(key: string, value: unknown) {
    const { storage, keyring, ownerId } = this.input;
    const text: string | undefined = JSON.stringify(value);
    if (text === undefined) {
      throw new SealFailedError("Only one JSON value can be sealed at a time");
    }
    await storage.put(key, await seal(keyring, text, contextOf(ownerId, key)));
  }

  delete(keys: string | string[]) {
    const { storage } = this.input;
    return typeof keys === "string"
      ? storage.delete(keys)
      : storage.delete(keys);
  }

  async list<Value>({ prefix }: { readonly prefix: string }) {
    const sealed = await this.input.storage.list<string>({ prefix });
    const opened = await Promise.all(
      [...sealed].map(
        async ([key, value]) =>
          [key, await this.unseal<Value>(key, value)] as const
      )
    );
    return new Map(opened);
  }
}

export const sealedOAuthStorage = (
  input: SealedOAuthStorageInput
): DurableObjectStorage =>
  new SealingStorage(input) as unknown as DurableObjectStorage;
