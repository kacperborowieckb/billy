import { Effect } from "effect";

import { openApprovals } from "../approval/open-approvals.ts";
import { markUntrustedContent } from "../notes/note.ts";

export const openApprovalsSection = Effect.gen(
  function* openApprovalsSectionEffect() {
    const open = yield* openApprovals;
    return {
      situation:
        open.length === 0
          ? []
          : [
              [
                "These Approvals wait for the Owner. Each one has buttons in the chat. Do not draft the same change again. The Owner answers only with the buttons: a typed yes or no does not answer an Approval. When the Owner types yes, say that they must tap the button.",
                ...open.map(
                  ({ pendingApprovalId, toolName, summary, trustLevel }) =>
                    `- ${pendingApprovalId} (${toolName}): ${trustLevel === "untrusted" ? markUntrustedContent(summary) : summary}`
                ),
              ].join("\n"),
            ],
      holdsUntrustedContent: open.some(
        ({ trustLevel }) => trustLevel === "untrusted"
      ),
    };
  }
);
