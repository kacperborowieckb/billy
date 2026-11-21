import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { env } from "cloudflare:test";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { RiskClass } from "../src/approval/risk-class.ts";
import { blockedCallReason } from "../src/approval/tool-gate.ts";
import { agentTool, runToolEffect } from "../src/model-gateway/agent-tool.ts";
import {
  aiGatewayHeaders,
  aiGatewayModelProvider,
} from "../src/model-gateway/ai-gateway.ts";
import { ModelGateway } from "../src/model-gateway/model-gateway.ts";
import { ModelProvider } from "../src/model-gateway/model-provider.ts";
import type { ResolvedRoute } from "../src/model-gateway/model-provider.ts";
import type { ModelStep } from "../src/model-gateway/model-step.ts";
import { UsageLedger } from "../src/model-gateway/usage-ledger.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { decodeTurnEnv } from "../src/personal-agent/turn-services.ts";
import { fakeModel, resetFakes, scriptModel } from "./fakes.ts";

const chatCompletion = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1_794_000_000,
  model: "anthropic/claude-sonnet-5-5",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hi there" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

describe("Model Gateway transport", () => {
  it("calls the model through the AI Gateway with the Owner Id metadata and no stored bodies", async () => {
    const requests: Request[] = [];
    const recordingFetch = (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Promise.resolve(Response.json(chatCompletion));
    };
    const provider = aiGatewayModelProvider(
      {
        url: "https://api.cloudflare.com/client/v4/accounts/account-1/ai/v1",
        gatewayId: "assistant",
        routes: {
          reply: {
            model: "anthropic/claude-sonnet-5-5",
            reasoningEffort: "none",
          },
          scheduled_task: {
            model: "anthropic/claude-sonnet-5-5",
            reasoningEffort: "none",
          },
          proactive: {
            model: "anthropic/claude-sonnet-5-5",
            reasoningEffort: "none",
          },
          eval_judge: {
            model: "anthropic/claude-opus-5-5",
            reasoningEffort: "low",
          },
        },
        fetch: recordingFetch,
      },
      { token: "gateway-token", billing: "unified-billing" },
      OwnerIdSchema.make("owner-7")
    );

    const reply = await Effect.runPromise(
      ModelProvider.pipe(
        Effect.flatMap((models) =>
          Effect.promise(() =>
            generateText({ model: models.route("reply").model, prompt: "Hi" })
          )
        ),
        Effect.provide(provider)
      )
    );

    expect(reply.text).toBe("Hi there");
    const [request] = requests;
    expect(request?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-1/ai/v1/chat/completions"
    );
    expect(request?.headers.get("Authorization")).toBe("Bearer gateway-token");
    expect(request?.headers.get("cf-aig-gateway-id")).toBe("assistant");
    expect(request?.headers.get("cf-aig-metadata")).toBe(
      JSON.stringify({ ownerId: "owner-7" })
    );
    expect(request?.headers.get("cf-aig-collect-log-payload")).toBe("false");
    expect(request?.headers.has("cf-aig-no-wholesale")).toBe(false);
    expect(await request?.json()).toMatchObject({
      model: "anthropic/claude-sonnet-5-5",
      reasoning_effort: "none",
    });
  });

  it("blocks the Unified Billing fallback when the billing mode is BYOK", () => {
    const headers = aiGatewayHeaders(
      "assistant",
      { token: "gateway-token", billing: "byok" },
      OwnerIdSchema.make("owner-7")
    );

    expect(headers["cf-aig-no-wholesale"]).toBe("true");
  });

  it("names the missing configuration without its values", async () => {
    const exit = await Effect.runPromiseExit(decodeTurnEnv(env));

    expect(Exit.isFailure(exit)).toBe(true);
    const failure = JSON.stringify(exit);
    expect(failure).toContain("AI_GATEWAY_URL");
    expect(failure).not.toContain(env.AI_GATEWAY_TOKEN);
    expect(failure).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });

  it("does not repeat a successful model call when the usage write fails", async () => {
    resetFakes();
    const failingLedger = Layer.succeed(UsageLedger, {
      record: () =>
        Effect.fail(
          new EffectDrizzleQueryError({
            query: "insert",
            params: undefined,
            cause: "disk full",
          })
        ),
      read: Effect.succeed([]),
      tokensSpent: () => Effect.succeed(0),
    });
    const gateway = ModelGateway.layer.pipe(
      Layer.provide(failingLedger),
      Layer.provide(
        Layer.succeed(ModelProvider, {
          route: () => ({ model: fakeModel, reasoningEffort: "none" }),
        })
      )
    );

    const exit = await Effect.runPromiseExit(
      ModelGateway.pipe(
        Effect.flatMap((models) =>
          models.generate({
            task: "reply",
            system: "Be brief.",
            messages: [{ role: "user", content: "Hi" }],
            trustLevel: "owner",
            stepLimit: 4,
          })
        ),
        Effect.provide(gateway)
      )
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(fakeModel.doGenerateCalls).toHaveLength(1);
  });
});

const gatewayWith = (model: ResolvedRoute["model"]) =>
  ModelGateway.layer.pipe(
    Layer.provide(
      Layer.succeed(UsageLedger, {
        record: () => Effect.void,
        read: Effect.succeed([]),
        tokensSpent: () => Effect.succeed(0),
      })
    ),
    Layer.provide(
      Layer.succeed(ModelProvider, {
        route: () => ({ model, reasoningEffort: "none" }),
      })
    )
  );

const fakeModelGateway = gatewayWith(fakeModel);

const WordInput = z.object({ word: z.string() });

const isWordInput = (value: unknown): value is z.infer<typeof WordInput> =>
  WordInput.safeParse(value).success;

const keepWordTool = (
  kept: string[],
  riskClass: RiskClass,
  riskClassOf?: (input: z.infer<typeof WordInput>) => RiskClass
) =>
  agentTool({
    description: "Keep a word",
    inputSchema: WordInput,
    riskClass,
    approvalSummary: {
      isInput: isWordInput,
      of: ({ word }) => Effect.succeed(`Keep the word "${word}"`),
    },
    ...(riskClassOf === undefined
      ? {}
      : { riskClassOfInput: { isInput: isWordInput, of: riskClassOf } }),
    execute: ({ word }) =>
      Effect.sync(() => {
        kept.push(word);
        return { kept: word };
      }),
  });

const toolOutputsSentToModel = () =>
  fakeModel.doGenerateCalls.flatMap((call) =>
    call.prompt.flatMap((message) =>
      message.role === "tool"
        ? message.content.flatMap((part) =>
            part.type === "tool-result" ? [part.output] : []
          )
        : []
    )
  );

const approvalPartsOf = (steps: readonly ModelStep[]) =>
  steps
    .flatMap((step) => step.responseMessages)
    .flatMap((message): readonly { readonly type: string }[] =>
      typeof message.content === "string" ? [] : message.content
    )
    .filter(
      (part) =>
        part.type === "tool-approval-request" ||
        part.type === "tool-approval-response"
    );

describe("The gate in the Model Gateway", () => {
  it.each([
    { name: "a blocked tool", riskClass: "blocked" as const },
    {
      name: "a tool raised to blocked by its input",
      riskClass: "change" as const,
      riskClassOfInput: ({ word }: { readonly word: string }) =>
        word === "secret" ? ("blocked" as const) : ("change" as const),
    },
  ])(
    "never runs $name and gives the model the reason",
    async ({ riskClass, riskClassOfInput }) => {
      resetFakes();
      scriptModel([
        { callTool: "keep_word", input: { word: "secret" } },
        { say: "I cannot keep that word." },
      ]);
      const kept: string[] = [];
      const tool = keepWordTool(kept, riskClass, riskClassOfInput);

      const reply = await Effect.runPromise(
        ModelGateway.pipe(
          Effect.flatMap((models) =>
            models.generate({
              task: "reply",
              system: "Be brief.",
              messages: [{ role: "user", content: "Keep secret" }],
              tools: { keep_word: tool },
              trustLevel: "owner",
              stepLimit: 4,
            })
          ),
          Effect.provide(fakeModelGateway)
        )
      );

      expect(kept).toEqual([]);
      expect(reply.text).toBe("I cannot keep that word.");
      expect(reply.endedWith).toEqual([]);
      expect(reply.steps[0]?.toolCalls).toEqual([
        expect.objectContaining({
          name: "keep_word",
          output: blockedCallReason,
          failed: true,
        }),
      ]);
      expect(toolOutputsSentToModel()).toEqual([
        { type: "execution-denied", reason: blockedCallReason },
      ]);
      expect(approvalPartsOf(reply.steps)).toEqual([]);
    }
  );

  it("never runs a blocked tool with a malformed input, and gives the model the reason", async () => {
    resetFakes();
    scriptModel([
      { callTool: "keep_word", input: { term: "secret" } },
      { say: "I cannot keep that word." },
    ]);
    const kept: string[] = [];

    await Effect.runPromise(
      ModelGateway.pipe(
        Effect.flatMap((models) =>
          models.generate({
            task: "reply",
            system: "Be brief.",
            messages: [{ role: "user", content: "Keep secret" }],
            tools: { keep_word: keepWordTool(kept, "blocked") },
            trustLevel: "owner",
            stepLimit: 4,
          })
        ),
        Effect.provide(fakeModelGateway)
      )
    );

    expect(kept).toEqual([]);
    expect(toolOutputsSentToModel()).toEqual([
      { type: "execution-denied", reason: blockedCallReason },
    ]);
  });

  it("never runs a blocked tool with input that is not JSON, and gives the model the reason", async () => {
    const kept: string[] = [];
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    let modelCalls = 0;
    const brokenJsonModel = new MockLanguageModelV4({
      doGenerate: () => {
        modelCalls += 1;
        return Promise.resolve(
          modelCalls === 1
            ? {
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "call-broken",
                    toolName: "keep_word",
                    input: '{"word": "sec',
                  },
                ],
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage,
                warnings: [],
              }
            : {
                content: [{ type: "text", text: "I cannot keep that word." }],
                finishReason: { unified: "stop", raw: "stop" },
                usage,
                warnings: [],
              }
        );
      },
    });

    await Effect.runPromise(
      ModelGateway.pipe(
        Effect.flatMap((models) =>
          models.generate({
            task: "reply",
            system: "Be brief.",
            messages: [{ role: "user", content: "Keep secret" }],
            tools: { keep_word: keepWordTool(kept, "blocked") },
            trustLevel: "owner",
            stepLimit: 4,
          })
        ),
        Effect.provide(gatewayWith(brokenJsonModel))
      )
    );

    const toolOutputs = brokenJsonModel.doGenerateCalls.flatMap((call) =>
      call.prompt.flatMap((message) =>
        message.role === "tool"
          ? message.content.flatMap((part) =>
              part.type === "tool-result" ? [part.output] : []
            )
          : []
      )
    );
    expect(kept).toEqual([]);
    expect(toolOutputs).toEqual([
      { type: "execution-denied", reason: blockedCallReason },
    ]);
  });

  it("never runs the work of a blocked tool, even when execute is called without the gate", async () => {
    const kept: string[] = [];
    const { execute } = keepWordTool(kept, "blocked").toAiSdkTool(
      runToolEffect(Effect.runPromise)
    );

    await expect(
      Promise.resolve(
        execute?.(
          { word: "secret" },
          { toolCallId: "call-1", messages: [], context: {} }
        )
      )
    ).rejects.toThrow(blockedCallReason);
    expect(kept).toEqual([]);
  });

  it("runs a change tool in an owner Turn", async () => {
    resetFakes();
    scriptModel([
      { callTool: "keep_word", input: { word: "milk" } },
      { say: "Kept." },
    ]);
    const kept: string[] = [];

    await Effect.runPromise(
      ModelGateway.pipe(
        Effect.flatMap((models) =>
          models.generate({
            task: "reply",
            system: "Be brief.",
            messages: [{ role: "user", content: "Keep milk" }],
            tools: { keep_word: keepWordTool(kept, "change") },
            trustLevel: "owner",
            stepLimit: 4,
          })
        ),
        Effect.provide(fakeModelGateway)
      )
    );

    expect(kept).toEqual(["milk"]);
  });

  it("stops a change call in an untrusted Turn before it runs, and returns its decoded input for Approval", async () => {
    resetFakes();
    scriptModel([
      { callTool: "keep_word", input: { word: "milk" } },
      { say: "Kept." },
    ]);
    const kept: string[] = [];

    const reply = await Effect.runPromise(
      ModelGateway.pipe(
        Effect.flatMap((models) =>
          models.generate({
            task: "reply",
            system: "Be brief.",
            messages: [{ role: "user", content: "Keep milk" }],
            tools: { keep_word: keepWordTool(kept, "change") },
            trustLevel: "untrusted",
            stepLimit: 4,
          })
        ),
        Effect.provide(fakeModelGateway)
      )
    );

    expect(kept).toEqual([]);
    expect(fakeModel.doGenerateCalls).toHaveLength(1);
    expect(reply.endedWith).toEqual([]);
    expect(reply.awaitingApproval).toEqual([
      {
        callId: expect.any(String),
        name: "keep_word",
        input: { word: "milk" },
      },
    ]);
    expect(JSON.stringify(reply.steps)).not.toContain("tool-approval");
  });
});
