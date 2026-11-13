// The "[EDIT]" exception to strikethrough: in a struck-through item, text from
// the first "[EDIT]" marker (any case) onward is shown without the strike, so a
// finished or canceled task can carry a note about what changed.

const MARKER = /\[edit\]/i;

export interface EditSplit {
  /** Text before the marker (struck through). */
  before: string;
  /** Text after the marker (not struck through), trimmed at the start. */
  after: string;
}

export function splitEditNote(text: string): EditSplit | null {
  const m = MARKER.exec(text);
  if (!m) return null;
  return { before: text.slice(0, m.index).trimEnd(), after: text.slice(m.index + m[0].length).trimStart() };
}
