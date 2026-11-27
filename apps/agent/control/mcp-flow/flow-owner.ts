import { Console, Effect, Option, Ref } from "effect";

import type { FakeTelegramMessage, startLocalFakes } from "../local-fakes.ts";
import { pressTelegramButton, sendTelegramUpdate } from "../telegram-update.ts";
import { McpFlowFailed } from "./flow-failed.ts";

const waitTimeout = "30 seconds";

export type LocalFakes = Effect.Success<ReturnType<typeof startLocalFakes>>;

export interface FlowOwnerOptions {
  readonly workerUrl: URL;
  readonly webhookSecret: string;
  readonly telegramUserId: number;
  readonly fakes: LocalFakes;
}

const within = <Value>(step: string, wait: Effect.Effect<Value>) =>
  wait.pipe(
    Effect.timeoutOption(waitTimeout),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new McpFlowFailed({ step, detail: "nothing arrived in time" })
          ),
        onSome: Effect.succeed,
      })
    )
  );

export const flowOwner = Effect.fnUntraced(function* flowOwner({
  workerUrl,
  webhookSecret,
  telegramUserId,
  fakes,
}: FlowOwnerOptions) {
  const nextId = yield* Ref.make(0);
  const seen: string[] = [];

  const nextMessage = (step: string) =>
    within(step, fakes.nextTelegramMessage).pipe(
      Effect.tap((message) => {
        seen.push(message.text);
        const buttons = (message.buttons ?? [])
          .map(({ text }) => `[${text}]`)
          .join(" ");
        return Console.log(
          `Billy: ${message.text}${buttons === "" ? "" : ` ${buttons}`}`
        );
      })
    );

  return {
    seen,
    say: Effect.fnUntraced(function* say(text: string) {
      const id = yield* Ref.updateAndGet(nextId, (last) => last + 1);
      yield* Console.log(`Owner: ${text}`);
      yield* sendTelegramUpdate({
        workerUrl,
        webhookSecret,
        update: {
          updateId: id,
          messageId: id,
          userId: telegramUserId,
          text,
        },
      });
    }),
    press: Effect.fnUntraced(function* press(
      message: FakeTelegramMessage,
      label: string
    ) {
      const button = message.buttons?.find(({ text }) => text.includes(label));
      if (button?.callback_data === undefined) {
        return yield* new McpFlowFailed({
          step: `press ${label}`,
          detail: "the message has no such button",
        });
      }
      const id = yield* Ref.updateAndGet(nextId, (last) => last + 1);
      yield* Console.log(`Owner presses ${button.text}`);
      yield* pressTelegramButton({
        workerUrl,
        webhookSecret,
        press: {
          updateId: id,
          userId: telegramUserId,
          messageId: message.messageId ?? 0,
          data: button.callback_data,
        },
      });
    }),
    nextMessage,
    nextEdit: (step: string) =>
      within(step, fakes.nextEdit).pipe(
        Effect.tap(({ text }) => {
          seen.push(text);
          return Console.log(`Billy edits the message: ${text}`);
        })
      ),
    nextDocument: (step: string) =>
      within(step, fakes.nextDocument).pipe(
        Effect.tap(({ fileName, content }) => {
          seen.push(content);
          return Console.log(`Billy sends the file ${fileName}:\n${content}`);
        })
      ),
  };
});

export type FlowOwner = Effect.Success<ReturnType<typeof flowOwner>>;
