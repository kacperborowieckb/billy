import { MockLanguageModelV4 } from "ai/test";

import { createFakeMcpServer } from "../control/fake-mcp-server.ts";
import {
  ownerContextLabel,
  runBlockLabel,
  textAfterContextBlock,
  turnContextLabel,
} from "../src/personal-agent/context-labels.ts";
import { burstMessageLabel } from "../src/personal-agent/event-message.ts";
import { TraceRetentionDaysSchema } from "../src/tracing/trace-retention-days.ts";

export const fakeTelegramApiUrl = "https://telegram.fake";

export const testTypingRepeatMillis = 100;

export interface SentTelegramMessage {
  readonly url: string;
  readonly body: {
    readonly chat_id: number;
    readonly text: string;
    readonly parse_mode?: string;
    readonly reply_parameters?: { readonly message_id: number };
    readonly reply_markup?: {
      readonly inline_keyboard: readonly (readonly {
        readonly text: string;
        readonly callback_data: string;
      }[])[];
    };
  };
}

export interface TelegramReaction {
  readonly chatId: number;
  readonly messageId: number;
  readonly emoji: string;
  readonly chatActionsBefore: number;
}

export type TelegramAnswer =
  | "confirm"
  | "refuse"
  | "lose-confirmation"
  | "lose-first-reaction-confirmation";

export interface TelegramChatAction {
  readonly chatId: number;
  readonly action: string;
  readonly at: number;
}

export interface TelegramPressAnswer {
  readonly callback_query_id: string;
  readonly text?: string;
}

export type ChatActionAnswer = "confirm" | "refuse" | "hang" | "hang-first";

export interface TelegramDocument {
  readonly chatId: number;
  readonly filename: string;
  readonly text: string;
}

const fakeTelegramState = {
  documents: [] as TelegramDocument[],
  documentsRefused: false,
  sent: [] as SentTelegramMessage[],
  reactions: [] as TelegramReaction[],
  answer: "confirm" as TelegramAnswer,
  chatActions: [] as TelegramChatAction[],
  chatActionAnswer: "confirm" as ChatActionAnswer,
  chatActionsAtModelCalls: [] as number[],
  chatActionsAtSends: [] as number[],
  sendDelayMillis: 0,
  sendHold: Promise.resolve() as Promise<undefined>,
  refusedFromSend: Number.POSITIVE_INFINITY,
  edits: [] as SentTelegramMessage[],
  editHold: Promise.resolve() as Promise<undefined>,
  editsToRefuse: 0,
  pressAnswers: [] as TelegramPressAnswer[],
  pressAnswerHold: Promise.resolve() as Promise<undefined>,
};

const answerEdit = async (request: Request) => {
  fakeTelegramState.edits.push({
    url: request.url,
    body: await request.json(),
  });
  await fakeTelegramState.editHold;
  if (fakeTelegramState.editsToRefuse > 0) {
    fakeTelegramState.editsToRefuse -= 1;
    return Response.json(
      { ok: false, description: "Bad Request: please retry" },
      { status: 400 }
    );
  }
  return Response.json({ ok: true, result: true });
};

const answerDocument = async (request: Request) => {
  const form = await request.formData();
  const file = form.get("document");
  fakeTelegramState.documents.push({
    chatId: Number(form.get("chat_id")),
    filename: file instanceof File ? file.name : "",
    text: file instanceof File ? await file.text() : "",
  });
  if (fakeTelegramState.documentsRefused) {
    return Response.json(
      { ok: false, description: "Bad Request: file refused" },
      { status: 400 }
    );
  }
  return Response.json({
    ok: true,
    result: { message_id: 8000 + fakeTelegramState.documents.length },
  });
};

const answerPressAnswer = async (request: Request) => {
  fakeTelegramState.pressAnswers.push(
    await request.json<TelegramPressAnswer>()
  );
  await fakeTelegramState.pressAnswerHold;
  return Response.json({ ok: true, result: true });
};

const answerChatAction = async (request: Request) => {
  const recorded = { chatId: 0, action: "", at: Date.now() };
  fakeTelegramState.chatActions.push(recorded);
  const body = await request.json<{ chat_id: number; action: string }>();
  recorded.chatId = body.chat_id;
  recorded.action = body.action;
  if (
    fakeTelegramState.chatActionAnswer === "hang" ||
    (fakeTelegramState.chatActionAnswer === "hang-first" &&
      fakeTelegramState.chatActions.length === 1)
  ) {
    return Promise.withResolvers<Response>().promise;
  }
  if (fakeTelegramState.chatActionAnswer === "refuse") {
    return Response.json(
      { ok: false, description: "Forbidden: bot was blocked by the user" },
      { status: 403 }
    );
  }
  return Response.json({ ok: true, result: true });
};

const answerReaction = async (request: Request) => {
  const body = await request.json<{
    chat_id: number;
    message_id: number;
    reaction: readonly { readonly emoji: string }[];
  }>();
  fakeTelegramState.reactions.push({
    chatId: body.chat_id,
    messageId: body.message_id,
    emoji: body.reaction.map((reaction) => reaction.emoji).join(""),
    chatActionsBefore: fakeTelegramState.chatActions.length,
  });
  if (fakeTelegramState.sendDelayMillis > 0) {
    await scheduler.wait(fakeTelegramState.sendDelayMillis);
  }
  if (
    fakeTelegramState.answer === "lose-confirmation" ||
    (fakeTelegramState.answer === "lose-first-reaction-confirmation" &&
      fakeTelegramState.reactions.length === 1)
  ) {
    throw new TypeError("The connection dropped before Telegram answered");
  }
  if (fakeTelegramState.answer === "refuse") {
    return Response.json(
      { ok: false, description: "Bad Request: REACTION_INVALID" },
      { status: 400 }
    );
  }
  return Response.json({ ok: true, result: true });
};

export const fakeTelegram = {
  refuseDocuments: () => {
    fakeTelegramState.documentsRefused = true;
  },
  get documents(): readonly TelegramDocument[] {
    return fakeTelegramState.documents;
  },
  get sent(): readonly SentTelegramMessage[] {
    return fakeTelegramState.sent;
  },
  get reactions(): readonly TelegramReaction[] {
    return fakeTelegramState.reactions;
  },
  get chatActions(): readonly TelegramChatAction[] {
    return fakeTelegramState.chatActions;
  },
  get chatActionsAtModelCalls(): readonly number[] {
    return fakeTelegramState.chatActionsAtModelCalls;
  },
  get chatActionsAtSends(): readonly number[] {
    return fakeTelegramState.chatActionsAtSends;
  },
  get edits(): readonly SentTelegramMessage[] {
    return fakeTelegramState.edits;
  },
  get pressAnswers(): readonly TelegramPressAnswer[] {
    return fakeTelegramState.pressAnswers;
  },
  holdPressAnswers: () => {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    fakeTelegramState.pressAnswerHold = promise;
    return () => resolve(undefined);
  },
  refuseNextEdits: (count: number) => {
    fakeTelegramState.editsToRefuse = count;
  },
  holdEdits: () => {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    fakeTelegramState.editHold = promise;
    return () => resolve(undefined);
  },
  refuseFromSend: (count: number) => {
    fakeTelegramState.refusedFromSend = count;
  },
  answerWith: (answer: TelegramAnswer) => {
    fakeTelegramState.answer = answer;
  },
  delaySendsBy: (millis: number) => {
    fakeTelegramState.sendDelayMillis = millis;
  },
  holdSends: () => {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    fakeTelegramState.sendHold = promise;
    return () => resolve(undefined);
  },
  answerChatActionsWith: (answer: ChatActionAnswer) => {
    fakeTelegramState.chatActionAnswer = answer;
  },
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/sendChatAction")) {
      return answerChatAction(request);
    }
    if (request.url.endsWith("/setMessageReaction")) {
      return answerReaction(request);
    }
    if (request.url.endsWith("/editMessageText")) {
      return answerEdit(request);
    }
    if (request.url.endsWith("/sendDocument")) {
      return answerDocument(request);
    }
    if (request.url.endsWith("/answerCallbackQuery")) {
      return answerPressAnswer(request);
    }
    fakeTelegramState.chatActionsAtSends.push(
      fakeTelegramState.chatActions.length
    );
    fakeTelegramState.sent.push({
      url: request.url,
      body: await request.json(),
    });
    if (fakeTelegramState.sendDelayMillis > 0) {
      await scheduler.wait(fakeTelegramState.sendDelayMillis);
    }
    await fakeTelegramState.sendHold;
    if (fakeTelegramState.answer === "lose-confirmation") {
      throw new TypeError("The connection dropped before Telegram answered");
    }
    if (
      fakeTelegramState.answer === "refuse" ||
      fakeTelegramState.sent.length >= fakeTelegramState.refusedFromSend
    ) {
      return Response.json(
        { ok: false, description: "Bad Request: chat not found" },
        { status: 400 }
      );
    }
    return Response.json({
      ok: true,
      result: { message_id: 9000 + fakeTelegramState.sent.length },
    });
  },
};

const recordedDataPoints: AnalyticsEngineDataPoint[] = [];

const metricsState = { failing: false };

const isModelStepPoint = (dataPoint: AnalyticsEngineDataPoint) =>
  dataPoint.blobs?.[0] === "model_step";

export const fakeMetrics = {
  get dataPoints(): readonly AnalyticsEngineDataPoint[] {
    return recordedDataPoints.filter((point) => !isModelStepPoint(point));
  },
  get modelStepDataPoints(): readonly AnalyticsEngineDataPoint[] {
    return recordedDataPoints.filter(isModelStepPoint);
  },
  failWrites: () => {
    metricsState.failing = true;
  },
  dataset: {
    writeDataPoint: (dataPoint?: AnalyticsEngineDataPoint) => {
      if (metricsState.failing) {
        throw new Error("Analytics Engine is down");
      }
      if (dataPoint !== undefined) {
        recordedDataPoints.push(dataPoint);
      }
    },
  } satisfies AnalyticsEngineDataset,
};

export const fakeReplyPrefix = "You said: ";

const lastOwnerText = (
  prompt: MockLanguageModelV4["doGenerateCalls"][number]["prompt"]
) => {
  const message = prompt.findLast((candidate) => candidate.role === "user");
  return message === undefined
    ? ""
    : textAfterContextBlock(userTextOf(message));
};

export interface ScriptedToolCall {
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

export interface ScriptedUsage {
  readonly inputTokens?: number | "unreported";
  readonly outputTokens?: number;
}

export type ScriptedModelStep =
  | ({ readonly say: string } & ScriptedUsage)
  | { readonly error: string }
  | { readonly callTools: readonly ScriptedToolCall[] }
  | ({
      readonly callTool: string;
      readonly times?: number;
      readonly input:
        | Record<string, unknown>
        | ((
            previousToolOutput: Record<string, unknown>
          ) => Record<string, unknown>);
    } & ScriptedUsage);

type ModelPrompt = MockLanguageModelV4["doGenerateCalls"][number]["prompt"];

const userTextOf = (message: ModelPrompt[number]) =>
  message.role === "user"
    ? message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
    : "";

export const lastUserTextOf = (prompt: ModelPrompt) =>
  prompt.map(userTextOf).findLast((text) => text !== "") ?? "";

export const systemTextOf = (prompt: ModelPrompt) => {
  const system = prompt.find((message) => message.role === "system");
  return system?.role === "system" ? system.content : "";
};

const blockOf = (text: string) =>
  text.startsWith(turnContextLabel) || text.startsWith(runBlockLabel)
    ? text.slice(0, text.length - textAfterContextBlock(text).length)
    : text;

export const contextBlockOf = (prompt: ModelPrompt, label: string) =>
  blockOf(
    prompt.map(userTextOf).findLast((text) => text.startsWith(label)) ?? ""
  );

export const ownerContextBlockOf = (prompt: ModelPrompt) =>
  contextBlockOf(prompt, ownerContextLabel);

export const ownerTextsOf = (prompt: ModelPrompt) =>
  prompt
    .map(userTextOf)
    .filter((text) => text !== "" && !text.startsWith(ownerContextLabel))
    .map(textAfterContextBlock);

export const instructionsAndContextOf = (prompt: ModelPrompt) =>
  [
    systemTextOf(prompt),
    contextBlockOf(prompt, ownerContextLabel),
    contextBlockOf(prompt, turnContextLabel),
    contextBlockOf(prompt, runBlockLabel),
  ].join("\n");

const lastToolOutput = (prompt: ModelPrompt): Record<string, unknown> => {
  const message = prompt.findLast((candidate) => candidate.role === "tool");
  const part = message?.content.find(
    (candidate) => candidate.type === "tool-result"
  );
  return part?.type === "tool-result" &&
    part.output.type === "json" &&
    typeof part.output.value === "object" &&
    part.output.value !== null &&
    !Array.isArray(part.output.value)
    ? { ...part.output.value }
    : {};
};

const modelScript: ScriptedModelStep[] = [];

export const scriptModel = (steps: readonly ScriptedModelStep[]) => {
  modelScript.splice(0, modelScript.length, ...steps);
};

const scriptedToolCalls = (calls: readonly ScriptedToolCall[]) =>
  calls.map((call, index) => ({
    type: "tool-call" as const,
    toolCallId: `call-${modelScript.length}-${index}`,
    toolName: call.tool,
    input: JSON.stringify(call.input),
  }));

const scriptedContent = (
  step: Exclude<ScriptedModelStep, { readonly error: string }>,
  prompt: ModelPrompt
) => {
  if ("say" in step) {
    return [{ type: "text", text: step.say }] as const;
  }
  if ("callTools" in step) {
    return scriptedToolCalls(step.callTools);
  }
  return Array.from({ length: step.times ?? 1 }, (_, index) => ({
    type: "tool-call" as const,
    toolCallId: `call-${modelScript.length}${index === 0 ? "" : `-${index}`}`,
    toolName: step.callTool,
    input: JSON.stringify(
      typeof step.input === "function"
        ? step.input(lastToolOutput(prompt))
        : step.input
    ),
  }));
};

const defaultModelFailureMessage = "The model provider is down";

const modelFailure = { remaining: 0, message: defaultModelFailureMessage };

const inputUsageOf = (inputTokens: number | "unreported") =>
  inputTokens === "unreported"
    ? {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      }
    : {
        total: inputTokens,
        noCache: inputTokens - 12,
        cacheRead: 12,
        cacheWrite: 0,
      };

const usageOf = ({ inputTokens = 42, outputTokens = 7 }: ScriptedUsage) => ({
  inputTokens: inputUsageOf(inputTokens),
  outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
});

const scriptedUsageOf = (
  scripted: ScriptedModelStep | undefined
): ScriptedUsage =>
  scripted !== undefined && ("say" in scripted || "callTool" in scripted)
    ? scripted
    : {};

const withinOutputLimit = (
  usage: ScriptedUsage,
  maxOutputTokens: number | undefined
) =>
  maxOutputTokens !== undefined &&
  usage.outputTokens !== undefined &&
  usage.outputTokens > maxOutputTokens
    ? {
        usage: { ...usage, outputTokens: maxOutputTokens },
        reachedOutputLimit: true,
      }
    : { usage, reachedOutputLimit: false };

const finishReasonOf = ({
  callsTool,
  reachedOutputLimit,
}: {
  readonly callsTool: boolean;
  readonly reachedOutputLimit: boolean;
}) => {
  if (reachedOutputLimit) {
    return { unified: "length", raw: "length" } as const;
  }
  return callsTool
    ? ({ unified: "tool-calls", raw: "tool_calls" } as const)
    : ({ unified: "stop", raw: "stop" } as const);
};

let releaseModel = Promise.resolve();
let callsBeforeHold = 0;

export const fakeModel = new MockLanguageModelV4({
  provider: "fake",
  modelId: "fake-reply-model",
  doGenerate: async (options) => {
    fakeTelegramState.chatActionsAtModelCalls.push(
      fakeTelegramState.chatActions.length
    );
    if (fakeModel.doGenerateCalls.length > callsBeforeHold) {
      await releaseModel;
    }
    options.abortSignal?.throwIfAborted();
    if (modelFailure.remaining > 0) {
      modelFailure.remaining -= 1;
      throw new Error(modelFailure.message);
    }
    const scripted = modelScript.shift();
    if (scripted !== undefined && "error" in scripted) {
      throw new Error(scripted.error);
    }
    const callsTool =
      scripted !== undefined &&
      ("callTool" in scripted || "callTools" in scripted);
    const { usage, reachedOutputLimit } = withinOutputLimit(
      scriptedUsageOf(scripted),
      options.maxOutputTokens
    );
    return {
      content:
        scripted === undefined
          ? [
              {
                type: "text",
                text: `${fakeReplyPrefix}${lastOwnerText(options.prompt)}`,
              },
            ]
          : [...scriptedContent(scripted, options.prompt)],
      finishReason: finishReasonOf({ callsTool, reachedOutputLimit }),
      usage: usageOf(usage),
      warnings: [],
    };
  },
});

export const holdModel = (answeredCalls = 0) => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  releaseModel = promise;
  callsBeforeHold = answeredCalls;
  return () => resolve(undefined);
};

export const failModel = (
  times: number,
  message = defaultModelFailureMessage
) => {
  modelFailure.remaining = times;
  modelFailure.message = message;
};

export const fakeToolApprovalExpiryMillis = 60 * 60 * 1000;

export const defaultFakeToolDescription = "Keep a word";

export const fakeTool = {
  name: "keep_note",
  description: defaultFakeToolDescription,
  kept: [] as string[],
  failWith: undefined as string | undefined,
};

export const defaultTestMaxRestarts = 2;

export const defaultTestTraceRetentionDays =
  TraceRetentionDaysSchema.make(3650);

export const fakeTraceRetention = {
  days: defaultTestTraceRetentionDays,
};

export const fakeBurstWait = {
  quietMillis: 0,
  maxWaitMillis: 0,
  maxRestarts: defaultTestMaxRestarts,
};

export const resetFakes = () => {
  fakeMcpServer.reset();
  Object.assign(fakeMcpLimits, defaultFakeMcpLimits);
  fakeTraceRetention.days = defaultTestTraceRetentionDays;
  fakeBurstWait.quietMillis = 0;
  fakeBurstWait.maxWaitMillis = 0;
  fakeBurstWait.maxRestarts = defaultTestMaxRestarts;
  modelScript.length = 0;
  fakeTool.kept = [];
  fakeTool.description = defaultFakeToolDescription;
  fakeTool.failWith = undefined;
  modelFailure.remaining = 0;
  modelFailure.message = defaultModelFailureMessage;
  recordedDataPoints.length = 0;
  metricsState.failing = false;
  fakeTelegramState.sent = [];
  fakeTelegramState.documents = [];
  fakeTelegramState.documentsRefused = false;
  fakeTelegramState.reactions = [];
  fakeTelegramState.answer = "confirm";
  fakeTelegramState.chatActions = [];
  fakeTelegramState.chatActionAnswer = "confirm";
  fakeTelegramState.chatActionsAtModelCalls = [];
  fakeTelegramState.chatActionsAtSends = [];
  fakeTelegramState.sendDelayMillis = 0;
  fakeTelegramState.sendHold = Promise.resolve(undefined);
  fakeTelegramState.refusedFromSend = Number.POSITIVE_INFINITY;
  fakeTelegramState.edits = [];
  fakeTelegramState.editHold = Promise.resolve(undefined);
  fakeTelegramState.editsToRefuse = 0;
  fakeTelegramState.pressAnswers = [];
  fakeTelegramState.pressAnswerHold = Promise.resolve(undefined);
  fakeCompletion.failures = 0;
  fakeCompletion.failuresAfterCommit = 0;
  fakeModel.doGenerateCalls.length = 0;
  releaseModel = Promise.resolve();
  callsBeforeHold = 0;
};

export const burstInputTexts = (...texts: readonly string[]) =>
  texts.map(
    (text, index) => `${burstMessageLabel(index + 1, texts.length)}\n${text}`
  );

export const fakeMcpServerUrl = "https://mcp.test.example/mcp";

export const fakeMcpServer = createFakeMcpServer();

export const mcpHubWakes = { count: 0 };

const defaultFakeMcpLimits = {
  callTimeoutMillis: 30_000,
  resultMaxCharacters: 8000,
};

export const fakeMcpLimits = { ...defaultFakeMcpLimits };

export const fakeCompletion = { failures: 0, failuresAfterCommit: 0 };
