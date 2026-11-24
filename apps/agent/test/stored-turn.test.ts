import { env, runInDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { captureNoteToolName } from "../src/notes/capture-note-tool.ts";
import { OwnerIdSchema } from "../src/owner-id.ts";
import { personalAgentFor } from "../src/personal-agent/personal-agent.ts";
import { fakeTelegram, resetFakes, scriptModel } from "./fakes.ts";
import { addOwner, telegramWebhook, textUpdate } from "./telegram-requests.ts";

const agentOf = (ownerId: string) =>
  personalAgentFor(env.PERSONAL_AGENT, OwnerIdSchema.make(ownerId));

const noteIdPlaceholder = "<note id>";

const storedConversationOf = async (ownerId: string) =>
  runInDurableObject(await agentOf(ownerId), (_, state) => {
    const noteIds = state.storage.sql
      .exec<{ note_id: string }>("SELECT note_id FROM notes")
      .toArray()
      .map((row) => row.note_id);
    return state.storage.sql
      .exec<{ message: string }>(
        "SELECT message FROM conversation_messages ORDER BY sequence"
      )
      .toArray()
      .map((row) => {
        let { message } = row;
        for (const noteId of noteIds) {
          message = message.replaceAll(noteId, noteIdPlaceholder);
        }
        return message;
      });
  });

const pendingEventCountOf = async (ownerId: string) =>
  runInDurableObject(
    await agentOf(ownerId),
    (_, state) =>
      state.storage.sql
        .exec<{ pending: number }>(
          "SELECT count(*) AS pending FROM inbox_events WHERE state = 'pending'"
        )
        .one().pending
  );

const captureThenReply = () =>
  scriptModel([
    { callTool: captureNoteToolName, input: { text: "buy tea" } },
    { say: "Kept: buy tea" },
  ]);

beforeEach(() => {
  resetFakes();
});

describe("The stored form of a Turn", () => {
  it("is the same bytes when recovery after a reset stores the Turn as when the normal path stores it", async () => {
    const normalOwner = await addOwner(7301);
    captureThenReply();
    await telegramWebhook(textUpdate({ fromUserId: 7301, text: "buy tea" }));
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    await vi.waitFor(async () =>
      expect(await pendingEventCountOf(normalOwner)).toBe(0)
    );
    const normal = await storedConversationOf(normalOwner);

    resetFakes();
    const recoveredOwner = await addOwner(7302);
    await runInDurableObject(
      await agentOf(recoveredOwner),
      async (instance, state) => {
        await instance.runtime.runPromise(Effect.void);
        state.storage.sql.exec(
          "CREATE TRIGGER conversation_fail BEFORE INSERT ON conversation_messages BEGIN SELECT RAISE(ABORT, 'reset before the Conversation write'); END"
        );
      }
    );
    captureThenReply();
    await telegramWebhook(textUpdate({ fromUserId: 7302, text: "buy tea" }));
    await vi.waitFor(() => expect(fakeTelegram.sent).toHaveLength(1));
    expect(await storedConversationOf(recoveredOwner)).toEqual([]);
    expect(await pendingEventCountOf(recoveredOwner)).toBe(1);

    await runInDurableObject(
      await agentOf(recoveredOwner),
      async (instance, state) => {
        state.storage.sql.exec("DROP TRIGGER conversation_fail");
        await instance.runTurn();
      }
    );

    expect(fakeTelegram.sent).toHaveLength(1);
    expect(await pendingEventCountOf(recoveredOwner)).toBe(0);
    expect(normal.map((message) => JSON.parse(message).role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(await storedConversationOf(recoveredOwner)).toEqual(normal);
  });
});
