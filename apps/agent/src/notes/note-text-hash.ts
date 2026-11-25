import { sha256Hex } from "../sha256-hex.ts";
import { normalizeNoteText } from "./note.ts";

export const hashOfNoteText = (text: string) =>
  sha256Hex(normalizeNoteText(text));
