import { DateTime, Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

const millisecondsPerSecond = 1000;

export interface TelegramTextUpdate {
  readonly updateId: number;
  readonly messageId: number;
  readonly userId: number;
  readonly text: string;
  readonly forwardedFrom?: string | undefined;
}

const telegramUpdateBody = (
  { updateId, messageId, userId, text, forwardedFrom }: TelegramTextUpdate,
  sentAt: DateTime.Utc
) => ({
  update_id: updateId,
  message: {
    message_id: messageId,
    date: Math.floor(DateTime.toEpochMillis(sentAt) / millisecondsPerSecond),
    chat: { id: userId, type: "private" },
    from: { id: userId, is_bot: false, first_name: "Owner" },
    text,
    ...(forwardedFrom === undefined
      ? {}
      : {
          forward_origin: {
            type: "user",
            sender_user: { first_name: forwardedFrom },
          },
        }),
  },
});

const postWebhook = Effect.fnUntraced(function* postWebhook({
  workerUrl,
  webhookSecret,
  body,
}: {
  readonly workerUrl: URL;
  readonly webhookSecret: string;
  readonly body: unknown;
}) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.post(new URL("/telegram/webhook", workerUrl)).pipe(
      HttpClientRequest.setHeader(
        "X-Telegram-Bot-Api-Secret-Token",
        webhookSecret
      ),
      HttpClientRequest.bodyJsonUnsafe(body)
    )
  );
  return { status: response.status, text: yield* response.text };
}, Effect.provide(FetchHttpClient.layer));

export const sendTelegramUpdate = Effect.fnUntraced(
  function* sendTelegramUpdate({
    workerUrl,
    webhookSecret,
    update,
  }: {
    readonly workerUrl: URL;
    readonly webhookSecret: string;
    readonly update: TelegramTextUpdate;
  }) {
    const sentAt = yield* DateTime.now;
    return yield* postWebhook({
      workerUrl,
      webhookSecret,
      body: telegramUpdateBody(update, sentAt),
    });
  }
);

export interface TelegramButtonPress {
  readonly updateId: number;
  readonly userId: number;
  readonly messageId: number;
  readonly data: string;
}

export const pressTelegramButton = Effect.fnUntraced(
  function* pressTelegramButton({
    workerUrl,
    webhookSecret,
    press,
  }: {
    readonly workerUrl: URL;
    readonly webhookSecret: string;
    readonly press: TelegramButtonPress;
  }) {
    const sentAt = yield* DateTime.now;
    return yield* postWebhook({
      workerUrl,
      webhookSecret,
      body: {
        update_id: press.updateId,
        callback_query: {
          id: `press-${press.updateId}`,
          from: { id: press.userId, is_bot: false, first_name: "Owner" },
          message: {
            message_id: press.messageId,
            date: Math.floor(
              DateTime.toEpochMillis(sentAt) / millisecondsPerSecond
            ),
            chat: { id: press.userId, type: "private" },
            text: "Approval",
          },
          chat_instance: "chat-instance-1",
          data: press.data,
        },
      },
    });
  }
);
