import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Effect, Queue, Schema } from "effect";

import type { ReviewAnswer } from "../src/auto-review/reviewer.ts";
import { fakeAssistantMessage } from "./fake-assistant-message.ts";
import { fakeChatActions, isSendChatAction } from "./fake-chat-actions.ts";
import {
  ChatCompletionBodySchema,
  lastOwnerText,
  instructionsAndContextOf,
  toolResultOf,
} from "./fake-completion.ts";
import { readBody, sendJson } from "./fake-http.ts";
import { fakeJudgeMessage, fakeJudgeModel } from "./fake-judge.ts";
import type { FakeJudgeVerdict } from "./fake-judge.ts";
import { toolCallNamesOf } from "./fake-model-call.ts";
import type { FakeModelCall } from "./fake-model-call.ts";
import { fakeReactions, isSetMessageReaction } from "./fake-reaction.ts";
import { fakeReviewOf, isFakeReviewRequest } from "./fake-reviewer.ts";
import type { FakeReview } from "./fake-reviewer.ts";
import {
  fakeTelegramButtons,
  ReplyMarkupSchema,
} from "./fake-telegram-buttons.ts";
import type { FakeTelegramButton } from "./fake-telegram-buttons.ts";

export type { FakeModelCall } from "./fake-model-call.ts";

export { fakeReplyPrefix } from "./fake-assistant-message.ts";

export interface FakeTelegramMessage {
  readonly messageId?: number;
  readonly buttons?: readonly FakeTelegramButton[];
  readonly chatId: number;
  readonly text: string;
  readonly replyToMessageId: number | undefined;
  readonly chatActionsBefore?: number;
}

type Completion = typeof ChatCompletionBodySchema.Type;

const SendMessageBodySchema = Schema.Struct({
  chat_id: Schema.Number,
  text: Schema.String,
  reply_parameters: Schema.optionalKey(
    Schema.Struct({ message_id: Schema.Number })
  ),
  reply_markup: Schema.optionalKey(ReplyMarkupSchema),
});

const headerValue = (request: IncomingMessage, name: string) => {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
};

const sendMessagePath = /^\/telegram\/bot[^/]+\/sendMessage$/u;
const chatCompletionsPath = "/ai-gateway/chat/completions";

export interface LocalFakesOptions {
  readonly judgeVerdicts?: readonly FakeJudgeVerdict[];
  readonly reviewAnswers?: readonly ReviewAnswer[];
}

export const startLocalFakes = Effect.fnUntraced(function* startLocalFakes({
  judgeVerdicts = [],
  reviewAnswers = [],
}: LocalFakesOptions = {}) {
  const telegramMessages = yield* Queue.unbounded<FakeTelegramMessage>();
  const sentTelegramMessages: FakeTelegramMessage[] = [];
  const chatActions = fakeChatActions();
  const reactions = fakeReactions();
  const modelCalls: FakeModelCall[] = [];
  const pendingJudgeVerdicts = [...judgeVerdicts];
  const pendingReviewAnswers = [...reviewAnswers];
  const reviews: FakeReview[] = [];
  const buttons = yield* fakeTelegramButtons();
  let nextMessageId = 1;

  const answerSendMessage = (body: unknown, response: ServerResponse) => {
    const message = Schema.decodeUnknownSync(SendMessageBodySchema)(body);
    nextMessageId += 1;
    const sent = {
      messageId: nextMessageId,
      buttons: message.reply_markup?.inline_keyboard.flat() ?? [],
      chatId: message.chat_id,
      text: message.text,
      replyToMessageId: message.reply_parameters?.message_id,
      chatActionsBefore: chatActions.list().length,
    };
    sentTelegramMessages.push(sent);
    Queue.offerUnsafe(telegramMessages, sent);
    sendJson(response, 200, {
      ok: true,
      result: { message_id: nextMessageId },
    });
  };

  const answerReview = (messages: Completion["messages"]) => {
    const { review, message } = fakeReviewOf(
      messages,
      pendingReviewAnswers.shift()
    );
    reviews.push(review);
    return message;
  };

  const answerOf = ({ model, messages }: Completion) => {
    if (isFakeReviewRequest(messages)) {
      return answerReview(messages);
    }
    return model === fakeJudgeModel
      ? fakeJudgeMessage(pendingJudgeVerdicts.shift() ?? "pass")
      : fakeAssistantMessage(
          lastOwnerText(messages),
          toolResultOf(messages),
          instructionsAndContextOf(messages)
        );
  };

  const answerChatCompletion = (
    request: IncomingMessage,
    body: unknown,
    response: ServerResponse
  ) => {
    const completion = Schema.decodeUnknownSync(ChatCompletionBodySchema)(body);
    const message = answerOf(completion);
    modelCalls.push({
      model: completion.model,
      gatewayId: headerValue(request, "cf-aig-gateway-id"),
      metadata: headerValue(request, "cf-aig-metadata"),
      collectLogPayload: headerValue(request, "cf-aig-collect-log-payload"),
      skipCache: headerValue(request, "cf-aig-skip-cache"),
      sessionAffinity: headerValue(request, "x-session-affinity"),
      lastUserMessage: lastOwnerText(completion.messages),
      toolCalls: toolCallNamesOf(message),
    });
    sendJson(response, 200, {
      id: `fake-completion-${modelCalls.length}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: completion.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: message.content === null ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    });
  };

  const server = createServer(async (request, response) => {
    try {
      if (await buttons.answer(request, response)) {
        return;
      }
      const body = await readBody(request);
      if (sendMessagePath.test(request.url ?? "")) {
        answerSendMessage(body, response);
        return;
      }
      if (isSendChatAction(request.url)) {
        sendJson(response, 200, chatActions.record(body));
        return;
      }
      if (isSetMessageReaction(request.url)) {
        sendJson(response, 200, reactions.record(body));
        return;
      }
      if (request.url === chatCompletionsPath) {
        answerChatCompletion(request, body, response);
        return;
      }
      sendJson(response, 404, { ok: false, description: "Not Found" });
    } catch (error) {
      sendJson(response, 400, { ok: false, description: String(error) });
    }
  });

  const port = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("The local fakes have no port");
      }
      return address.port;
    }),
    () =>
      Effect.promise(async () => {
        server.close();
        await once(server, "close");
      })
  );
  const origin = `http://127.0.0.1:${port}`;

  return {
    telegramApiUrl: `${origin}/telegram`,
    aiGatewayUrl: `${origin}/ai-gateway`,
    nextTelegramMessage: Queue.take(telegramMessages),
    nextEdit: buttons.nextEdit,
    nextDocument: buttons.nextDocument,
    sentTelegramMessages: () => [...sentTelegramMessages],
    chatActions: chatActions.list,
    reactions: reactions.list,
    modelCalls: () => [...modelCalls],
    reviews: () => [...reviews],
  };
});
