import type { IncomingMessage, ServerResponse } from "node:http";

import { Effect, Queue, Schema } from "effect";

import { readBody, sendJson } from "./fake-http.ts";

export const FakeButtonSchema = Schema.Struct({
  text: Schema.String,
  callback_data: Schema.optionalKey(Schema.String),
  login_url: Schema.optionalKey(Schema.Struct({ url: Schema.String })),
});

export type FakeTelegramButton = typeof FakeButtonSchema.Type;

export const ReplyMarkupSchema = Schema.Struct({
  inline_keyboard: Schema.Array(Schema.Array(FakeButtonSchema)),
});

export interface FakeTelegramEdit {
  readonly messageId: number;
  readonly text: string;
}

export interface FakeTelegramDocument {
  readonly fileName: string;
  readonly content: string;
}

const EditBodySchema = Schema.Struct({
  message_id: Schema.Number,
  text: Schema.String,
});

const documentPath = /^\/telegram\/bot[^/]+\/sendDocument$/u;
const editPath = /^\/telegram\/bot[^/]+\/editMessageText$/u;
const pressAnswerPath = /^\/telegram\/bot[^/]+\/answerCallbackQuery$/u;

const rawBodyOf = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
};

const documentOf = async (request: IncomingMessage) => {
  const form = await new Response(await rawBodyOf(request), {
    headers: { "Content-Type": request.headers["content-type"] ?? "" },
  }).formData();
  const file = form.get("document");
  if (file === null || typeof file === "string") {
    throw new Error("sendDocument has no document");
  }
  return { fileName: file.name, content: await file.text() };
};

export const fakeTelegramButtons = Effect.fnUntraced(
  function* fakeTelegramButtons() {
    const edits = yield* Queue.unbounded<FakeTelegramEdit>();
    const documents = yield* Queue.unbounded<FakeTelegramDocument>();

    const answer = async (
      request: IncomingMessage,
      response: ServerResponse
    ) => {
      const path = request.url ?? "";
      if (documentPath.test(path)) {
        Queue.offerUnsafe(documents, await documentOf(request));
      } else if (editPath.test(path)) {
        const edit = Schema.decodeUnknownSync(EditBodySchema)(
          await readBody(request)
        );
        Queue.offerUnsafe(edits, {
          messageId: edit.message_id,
          text: edit.text,
        });
      } else if (!pressAnswerPath.test(path)) {
        return false;
      }
      sendJson(response, 200, { ok: true, result: { message_id: 1 } });
      return true;
    };

    return {
      answer,
      nextEdit: Queue.take(edits),
      nextDocument: Queue.take(documents),
    };
  }
);
