import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { operatorPost } from "./operator-request.ts";

const post = (workerUrl: string) =>
  Effect.runPromise(
    operatorPost({
      workerUrl,
      path: "/operator/owners",
      token: "token",
      body: {},
    }).pipe(
      Effect.map(() => "sent"),
      Effect.catchTag("OperatorUrlRefused", () => Effect.succeed("refused"))
    )
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a request with the Operator token", () => {
  it.each([
    "https://agent.example.workers.dev",
    "http://localhost:8787",
    "http://127.0.0.1:43731",
    "http://[::1]:8787",
  ])("is sent to %s", async (workerUrl) => {
    const send = vi.fn(() => Promise.resolve(new Response()));
    vi.stubGlobal("fetch", send);

    expect(await post(workerUrl)).toBe("sent");
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    "http://agent.example.workers.dev",
    "http://localhost.example.com",
    "ftp://localhost",
  ])("is not sent to %s", async (workerUrl) => {
    const send = vi.fn(() => Promise.resolve(new Response()));
    vi.stubGlobal("fetch", send);

    expect(await post(workerUrl)).toBe("refused");
    expect(send).not.toHaveBeenCalled();
  });
});
