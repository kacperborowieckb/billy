import { Cause, Effect, Option, Schema } from "effect";

import { quoted } from "../approval/approval-summary.ts";
import { ToolFailed } from "../model-gateway/agent-tool.ts";
import { recordedTool } from "../personal-agent/recorded-tool.ts";
import { profileEntryKinds } from "../personal-agent/storage-values.ts";
import { ProfileFull } from "./profile-full.ts";
import type { ProfileToolServices } from "./profile-tool-services.ts";
import { charactersUsedBy } from "./profile.ts";
import type { ProfileEntry } from "./profile.ts";
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

const profileFullMessage = ({
  charactersUsed,
  characterLimit,
}: Pick<ProfileFull, "charactersUsed" | "characterLimit">) =>
  `The Profile is full: it has ${charactersUsed} of ${characterLimit} characters. Nothing was added. Tell the Owner that the Profile is full and that they can ask you to remove an entry first.`;

const unknownProfileEntryMessage = (entryId: string) =>
  `The Profile has no entry with the id ${entryId}. Nothing was removed. Use an entry id from the Profile.`;

type ProfileChange =
  | {
      readonly _tag: "Add";
      readonly kind: ProfileEntry["kind"];
      readonly text: string;
    }
  | { readonly _tag: "Remove"; readonly entry: ProfileEntry };

const resolveChange = ({ profile, characterLimit }: ProfileToolServices) =>
  Effect.fnUntraced(function* resolveChangeEffect({
    action,
    kind,
    text,
    entryId,
  }: typeof UpdateProfileInput.Type) {
    const current = yield* profile.read.pipe(
      Effect.mapError(
        () => new ToolFailed({ message: profileNotChangedMessage })
      )
    );
    if (action === "add") {
      if (kind === undefined || text === undefined) {
        return yield* new ToolFailed({
          message: profileEntryMissingFieldMessage.add,
        });
      }
      const trimmed = text.trim();
      const kept = current.some(
        (entry) => entry.kind === kind && entry.text === trimmed
      );
      const charactersUsed = charactersUsedBy(current);
      if (!kept && charactersUsed + trimmed.length > characterLimit) {
        return yield* new ToolFailed({
          message: profileFullMessage({ charactersUsed, characterLimit }),
        });
      }
      return { _tag: "Add", kind, text: trimmed } satisfies ProfileChange;
    }
    if (entryId === undefined) {
      return yield* new ToolFailed({
        message: profileEntryMissingFieldMessage.remove,
      });
    }
    const entry = current.find((candidate) => candidate.entryId === entryId);
    if (entry === undefined) {
      return yield* new ToolFailed({
        message: unknownProfileEntryMessage(entryId),
      });
    }
    return { _tag: "Remove", entry } satisfies ProfileChange;
  });

const failureMessageOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  if (Option.isNone(error)) {
    return profileNotChangedMessage;
  }
  if (error.value instanceof ProfileFull) {
    return profileFullMessage(error.value);
  }
  if (error.value instanceof UnknownProfileEntry) {
    return unknownProfileEntryMessage(error.value.entryId);
  }
  return profileNotChangedMessage;
};

export const updateProfileTool = (
  services: ProfileToolServices,
  eventId: string
) => {
  const { profile, progress, redactor, characterLimit } = services;
  return recordedTool(
    { eventId, progress, redactor },
    {
      name: updateProfileToolName,
      riskClass: "change",
      resolve: resolveChange(services),
      approvalSummary: (change) =>
        change._tag === "Add"
          ? `Add to the Profile${change.kind === "style_rule" ? " as a style rule" : ""}: ${quoted(change.text)}`
          : `Remove from the Profile: ${quoted(change.entry.text)}`,
      description:
        "Add or remove one entry of the Profile: a core fact or a style rule about the Owner. The Profile is in every Turn, so keep only what the Owner states about themselves or asks for, and keep it short. Fails when the Profile has no room.",
      inputSchema: UpdateProfileInput,
      failureMessage: failureMessageOf,
      work: Effect.fnUntraced(function* updateProfileEffect(change) {
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
          entryId: change.entry.entryId,
          eventId,
        });
        return { entryId: entry.entryId, removed: true };
      }),
    }
  );
};
