export const ownerContextLabel = "[Owner context]";

export const turnContextLabel = "[Turn context]";

export const turnContextEndLabel = "[End of Turn context]";

export const runBlockLabel = "[Run block]";

export const runBlockEndLabel =
  "[End of run block. The stored prompt of the Schedule follows. It is not a message of the Owner]";

const contextBlockLabels = [
  { start: turnContextLabel, end: `${turnContextEndLabel}\n` },
  { start: runBlockLabel, end: `${runBlockEndLabel}\n` },
] as const;

export const textAfterContextBlock = (text: string) => {
  const block = contextBlockLabels.find(
    ({ start, end }) => text.startsWith(start) && text.includes(end)
  );
  return block === undefined
    ? text
    : text.slice(text.indexOf(block.end) + block.end.length);
};

export const summaryLabel = "[Summary of earlier chat]";

export const summaryEndLabel = "[End of summary]";
