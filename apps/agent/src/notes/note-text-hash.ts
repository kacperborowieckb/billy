import { contentHashOf } from "../tracing/content-hash.ts";
import { normalizeNoteText } from "./note.ts";

export const hashOfNoteText = (text: string) =>
  contentHashOf(normalizeNoteText(text));
