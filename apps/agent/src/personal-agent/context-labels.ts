export const ownerContextLabel = "[Owner context]";

export const turnContextLabel = "[Turn context]";

export const turnContextEndLabel = "[End of Turn context]";

const turnContextEnd = `${turnContextEndLabel}\n`;

export const textAfterTurnContext = (text: string) =>
  text.startsWith(turnContextLabel) && text.includes(turnContextEnd)
    ? text.slice(text.indexOf(turnContextEnd) + turnContextEnd.length)
    : text;

export const summaryLabel = "[Summary of earlier chat]";

export const summaryEndLabel = "[End of summary]";
