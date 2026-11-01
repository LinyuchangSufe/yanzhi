/** A textarea normalizes CRLF and CR to LF; persisted note offsets must not. */
export function originalTextOffset(text: string, textareaOffset: number): number {
  const limit = Math.max(0, Math.trunc(textareaOffset));
  let original = 0;
  let displayed = 0;
  while (original < text.length && displayed < limit) {
    if (text[original] === "\r" && text[original + 1] === "\n") original += 1;
    original += 1;
    displayed += 1;
  }
  return original;
}
