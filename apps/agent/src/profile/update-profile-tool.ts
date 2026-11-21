import { Cause, Effect, Option, Schema } from "effect";

import { quoted } from "../approval/approval-summary.ts";
import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { profileEntryKinds } from "../personal-agent/storage-values.ts";
import { ProfileFull } from "./profile-full.ts";
import type { ProfileToolServices } from "./profile-tool-services.ts";
import { charactersUsedBy } from "./profile.ts";
import { UnknownProfileEntry } from "./unknown-profile-entry.ts";

export const updateProfileToolName = "update_profile";

export const profileNotChangedMessage =
  "The Profile was not changed. Tell the Owner that you could not change it.";

export const profileEntryMissingFieldMessage = {
  add: "The Profile was not changed. To add an entry, give its kind and its text.",
  remove:
    "The Profile was not changed. To remove an entry, give its entry id from the Profile.",
} as const;

const NonBlank = Schema.String.pipe(Schema.check(Schema.isPattern(/\S/u)));

const UpdateProfileInput = Schema.Struct({
  action: Schema.Literals(["add", "remove"]).pipe(
    Schema.annotate({ description: "Add one entry or remove one entry." })
  ),
  kind: Schema.optionalKey(
    Schema.Literals(profileEntryKinds).pipe(
      Schema.annotate({
        description:
          "For add: fact for a core fact about the Owner, style_rule for how the Owner wants you to write or act.",
      })
    )
  ),
  text: Schema.optionalKey(
    NonBlank.pipe(
      Schema.annotate({
        description:
          "For add: one short entry, in the words of the Owner. One fact or one rule.",
      })
    )
  ),
  entryId: Schema.optionalKey(
    NonBlank.pipe(
      Schema.annotate({
        description:
          "For remove: the entry id of the entry, as the Profile in the system prompt shows it.",
      })
    )
  ),
});

const profileFullMessage = (charactersUsed: number, characterLimit: number) =>
  `The Profile is full: it has ${charactersUsed} of ${characterLimit} characters. Nothing was added. Tell the Owner that the Profile is full and that they can ask you to remove an entry first.`;

const unknownProfileEntryMessage = (entryId: string) =>
  `The Profile has no entry with the id ${entryId}. Nothing was removed. Use an entry id from the Profile.`;

type ProfileChange =
  | {
      readonly _tag: "Add";
      readonly kind: (typeof profileEntryKinds)[number];
      readonly text: string;
    }
  | { readonly _tag: "Remove"; readonly entryId: string };

const checkedProfileChange = ({
  action,
  kind,
  text,
  entryId,
}: typeof UpdateProfileInput.Type) => {
  if (action === "add") {
    return kind === undefined || text === undefined
      ? Effect.fail(
          new ToolFailed({ message: profileEntryMissingFieldMessage.add })
        )
      : Effect.succeed<ProfileChange>({ _tag: "Add", kind, text: text.trim() });
  }
  return entryId === undefined
    ? Effect.fail(
        new ToolFailed({ message: profileEntryMissingFieldMessage.remove })
      )
    : Effect.succeed<ProfileChange>({ _tag: "Remove", entryId });
};

const failureMessageOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  if (Option.isNone(error)) {
    return profileNotChangedMessage;
  }
  if (error.value instanceof ProfileFull) {
    return profileFullMessage(
      error.value.charactersUsed,
      error.value.characterLimit
    );
  }
  if (error.value instanceof UnknownProfileEntry) {
    return unknownProfileEntryMessage(error.value.entryId);
  }
  return profileNotChangedMessage;
};

export const updateProfileTool = (
  { profile, progress, redactor, characterLimit }: ProfileToolServices,
  eventId: string
) =>
  recordedTool(
    { eventId, progress, redactor },
    {
      name: updateProfileToolName,
      riskClass: "change",
      approvalSummary: Effect.fnUntraced(function* profileSummaryEffect(input) {
        const change = yield* checkedProfileChange(input);
        const entries = yield* profile.read.pipe(
          Effect.mapError(
            () => new ToolFailed({ message: profileNotChangedMessage })
          )
        );
        if (change._tag === "Add") {
          const kept = entries.some(
            (entry) => entry.kind === change.kind && entry.text === change.text
          );
          const charactersUsed = charactersUsedBy(entries);
          if (!kept && charactersUsed + change.text.length > characterLimit) {
            return yield* new ToolFailed({
              message: profileFullMessage(charactersUsed, characterLimit),
            });
          }
          return `Add to the Profile${change.kind === "style_rule" ? " as a style rule" : ""}: ${quoted(change.text)}`;
        }
        const entry = entries.find(
          (candidate) => candidate.entryId === change.entryId
        );
        if (entry === undefined) {
          return yield* new ToolFailed({
            message: unknownProfileEntryMessage(change.entryId),
          });
        }
        return `Remove from the Profile: ${quoted(entry.text)}`;
      }),
      description:
        "Add or remove one entry of the Profile: a core fact or a style rule about the Owner. The Profile is in every Turn, so keep only what the Owner states about themselves or asks for, and keep it short. Fails when the Profile has no room.",
      inputSchema: UpdateProfileInput,
      failureMessage: failureMessageOf,
      work: Effect.fnUntraced(function* updateProfileEffect(input) {
        const change = yield* checkedProfileChange(input);
        if (change._tag === "Add") {
          const { entry, alreadyKept, charactersUsed } = yield* profile.add({
            kind: change.kind,
            text: change.text,
            eventId,
            characterLimit,
          });
          return {
            entryId: entry.entryId,
            kind: entry.kind,
            text: entry.text,
            alreadyKept,
            charactersUsed,
            characterLimit,
          };
        }
        const entry = yield* profile.remove({
          entryId: change.entryId,
          eventId,
        });
        return { entryId: entry.entryId, removed: true };
      }),
    }
  );
