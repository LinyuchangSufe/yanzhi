/** Hide internal anchor IDs from generated prose; literal PDF quotes are never passed here. */
export function cleanGuideText(
  text: string,
  evidenceIds: readonly string[],
): string {
  const suffixes = new Set(evidenceIds.flatMap((id) => {
    const match = id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(\d+:\d+)$/i);
    return match ? [match[1]] : [];
  }));
  // Models sometimes abbreviate a known UUID anchor as “（证据0:1）”.
  // Remove only complete evidence-only parentheticals, never ordinary ratios,
  // unknown references, prose containing evidence labels, or formula syntax.
  let result = text.replace(/（([^（）]*)）|\(([^()]*)\)/g, (whole, chinese: string | undefined, ascii: string | undefined) => {
    const parts = (chinese ?? ascii ?? "").trim().split(/\s*[,，、;；]\s*/);
    return parts.every((part, index) => {
      const match = part.match(index === 0 ? /^证据\s*(\d+:\d+)$/ : /^(?:证据\s*)?(\d+:\d+)$/);
      return match !== null && suffixes.has(match[1]);
    }) ? "" : whole;
  });
  for (const id of evidenceIds) {
    result = result.split(`[${id}]`).join("");
    result = result.split(id).join("");
  }
  return result.replace(/[ \t]+\n/g, "\n").trim();
}
