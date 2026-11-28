export const sampleMessageId = 7;

export interface NumberedMessage {
  readonly text: string;
  readonly updateId: number;
  readonly messageId: number;
  readonly forwardedFrom?: string;
}

interface SentTexts {
  readonly messages: readonly string[];
  readonly burst: boolean;
  readonly forward: string | undefined;
}

const forwardSender = "Ana";

export const messageGroups = ({ messages, burst, forward }: SentTexts) => {
  const last = messages.length - 1;
  const sent = messages.flatMap((text, index) => [
    ...(index === last && forward !== undefined
      ? [{ text: forward, forwardedFrom: forwardSender }]
      : []),
    { text },
  ]);
  const numbered = sent.map((message, index): NumberedMessage => ({
    ...message,
    updateId: index + 1,
    messageId: sampleMessageId + index + 1,
  }));
  if (burst) {
    return [numbered];
  }
  const together = forward === undefined ? 1 : 2;
  return [
    ...numbered.slice(0, -together).map((message) => [message]),
    numbered.slice(-together),
  ];
};
