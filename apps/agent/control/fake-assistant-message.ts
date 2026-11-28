import { proactiveMarker } from "../src/personal-agent/proactive-marker.ts";
import { scheduledTaskMarker } from "../src/personal-agent/scheduled-task-section.ts";
import {
  fakeBriefMessage,
  fakeBriefMoveMessage,
  isFakeBriefMove,
} from "./fake-brief.ts";
import { withoutBurstLabel } from "./fake-completion.ts";
import { fakeKeepMessage, fakeKeepPrefix } from "./fake-keep.ts";
import { fakeMcpMessage, isFakeMcpMessage } from "./fake-mcp.ts";
import { fakeNoteEditMessage, isFakeNoteEdit } from "./fake-note-edits.ts";
import {
  fakeOpenLoopMessage,
  isFakeOpenLoopMessage,
} from "./fake-open-loops.ts";
import { fakeReactionMessage, isFakeReaction } from "./fake-reaction.ts";
import { fakeRecallMessage, fakeRecallPrefix } from "./fake-recall.ts";
import {
  fakeCancelReminderMessage,
  fakeCancelReminderPrefix,
} from "./fake-schedule-cancel.ts";
import {
  fakeScheduleMessage,
  fakeScheduledTaskMessage,
  isFakeScheduleRequest,
} from "./fake-schedule.ts";
import { fakeSmallTalkMessage, isFakeSmallTalk } from "./fake-small-talk.ts";
import {
  fakeTimeZoneMessage,
  isFakeTimeZoneMessage,
} from "./fake-time-zone.ts";
import {
  fakeNotionMessage,
  isFakeNotionMessage,
} from "./mcp-flow/fake-notion-model.ts";

export const fakeReplyPrefix = "You said: ";

export const fakeAssistantMessage = (
  ownerText: string,
  toolResult: string | undefined,
  systemText: string
) => {
  if (systemText.includes(proactiveMarker)) {
    return fakeBriefMessage(systemText);
  }
  if (systemText.includes(scheduledTaskMarker)) {
    return fakeScheduledTaskMessage(ownerText);
  }
  if (isFakeNotionMessage(ownerText)) {
    return fakeNotionMessage(ownerText, toolResult);
  }
  if (isFakeMcpMessage(ownerText)) {
    return fakeMcpMessage(ownerText, toolResult);
  }
  if (isFakeSmallTalk(ownerText)) {
    return fakeSmallTalkMessage(toolResult);
  }
  if (isFakeReaction(ownerText)) {
    return fakeReactionMessage(ownerText, toolResult);
  }
  if (isFakeBriefMove(ownerText)) {
    return fakeBriefMoveMessage(toolResult, systemText);
  }
  if (isFakeTimeZoneMessage(ownerText)) {
    return fakeTimeZoneMessage(ownerText, toolResult, systemText);
  }
  const request = withoutBurstLabel(ownerText);
  if (isFakeScheduleRequest(request)) {
    return fakeScheduleMessage(request, toolResult, systemText);
  }
  if (ownerText.startsWith(fakeCancelReminderPrefix)) {
    return fakeCancelReminderMessage(ownerText, toolResult);
  }
  if (ownerText.startsWith(fakeRecallPrefix)) {
    return fakeRecallMessage(ownerText, toolResult);
  }
  if (isFakeNoteEdit(ownerText)) {
    return fakeNoteEditMessage(ownerText, toolResult);
  }
  if (isFakeOpenLoopMessage(ownerText)) {
    return fakeOpenLoopMessage(ownerText, toolResult);
  }
  return ownerText.startsWith(fakeKeepPrefix)
    ? fakeKeepMessage(ownerText, toolResult)
    : { role: "assistant", content: `${fakeReplyPrefix}${ownerText}` };
};
