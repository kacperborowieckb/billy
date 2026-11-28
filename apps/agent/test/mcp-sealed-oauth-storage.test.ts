import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { sealedOAuthStorage } from "../src/mcp/sealed-oauth-storage.ts";
import { parseSealKeyring, SealFailedError } from "../src/mcp/token-seal.ts";

const tokensKey = "/Billy/notion/client-1/token";
const verifierKey = "/Billy/notion/client-1/code_verifier";
const otherConnectionKey = "/Billy/linear/client-1/token";

const tokens = { access_token: "plain-access", refresh_token: "plain-refresh" };

const withStorage = async <Value>(
  work: (
    storageOf: (ownerId: string) => DurableObjectStorage,
    raw: DurableObjectStorage
  ) => Promise<Value>
) => {
  const keyring = await parseSealKeyring(env.MCP_SEALING_KEYS);
  const hub = env.MCP_HUB.getByName(crypto.randomUUID());
  return runInDurableObject(hub, (_instance, { storage }) =>
    work(
      (ownerId) => sealedOAuthStorage({ storage, keyring, ownerId }),
      storage
    )
  );
};

describe("the sealing OAuth storage", () => {
  it("stores a sealed record and opens it again", () =>
    withStorage(async (storageOf, raw) => {
      await storageOf("owner-1").put(tokensKey, tokens);

      const stored = await raw.get<string>(tokensKey);
      expect(stored).toMatch(/^v1\.test-1\./u);
      expect(stored).not.toContain("plain-");
      expect(await storageOf("owner-1").get(tokensKey)).toEqual(tokens);
      expect(await storageOf("owner-1").get(verifierKey)).toBeUndefined();
    }));

  it.each([
    ["Connection", otherConnectionKey],
    ["purpose", verifierKey],
  ])("does not open a record that was copied to another %s", (_, key) =>
    withStorage(async (storageOf, raw) => {
      await storageOf("owner-1").put(tokensKey, tokens);
      await raw.put(key, await raw.get(tokensKey));

      await expect(storageOf("owner-1").get(key)).rejects.toBeInstanceOf(
        SealFailedError
      );
    })
  );

  it("does not open the record of another Owner", () =>
    withStorage(async (storageOf) => {
      await storageOf("owner-1").put(tokensKey, tokens);

      await expect(storageOf("owner-2").get(tokensKey)).rejects.toBeInstanceOf(
        SealFailedError
      );
    }));

  it("lists the opened records of a prefix and deletes them", () =>
    withStorage(async (storageOf) => {
      const storage = storageOf("owner-1");
      await storage.put(tokensKey, tokens);
      await storage.put(verifierKey, { verifier: "plain-verifier" });
      await storage.put(otherConnectionKey, tokens);

      const listed = await storage.list({ prefix: "/Billy/notion/" });
      expect([...listed]).toEqual([
        [verifierKey, { verifier: "plain-verifier" }],
        [tokensKey, tokens],
      ]);

      expect(await storage.delete(verifierKey)).toBe(true);
      expect(await storage.delete([tokensKey, otherConnectionKey])).toBe(2);
      expect([...(await storage.list({ prefix: "/Billy/" }))]).toEqual([]);
    }));

  it("refuses a value that is not one JSON value", () =>
    withStorage(async (storageOf, raw) => {
      await expect(
        storageOf("owner-1").put(tokensKey, undefined)
      ).rejects.toBeInstanceOf(SealFailedError);
      expect(await raw.get(tokensKey)).toBeUndefined();
    }));
});
