/** Shared form rules: selecting and typing tags never writes to the library. */
export function parseTagInput(input: string): string[] {
  return input.split(/[,，]/).map((name) => name.trim()).filter(Boolean);
}

const key = (name: string) => name.trim().toLowerCase();

/** Preserve saved spellings and selected order while avoiding duplicate names. */
export function normalizeTagNames(names: readonly string[], existing: readonly string[] = []): string[] {
  const savedNames = new Map<string, string>();
  for (const name of existing) {
    const trimmed = name.trim();
    if (trimmed && !savedNames.has(key(trimmed))) savedNames.set(key(trimmed), trimmed);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    const normalized = key(trimmed);
    if (!trimmed || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(savedNames.get(normalized) ?? trimmed);
  }
  return result;
}

/** Include uncommitted text when the user saves without pressing Enter first. */
export function submittedTagNames(selected: readonly string[], draft: string, existing: readonly string[]): string[] {
  return normalizeTagNames([...selected, ...parseTagInput(draft)], existing);
}

export function toggleTagName(selected: readonly string[], name: string, existing: readonly string[]): string[] {
  return selected.some((entry) => key(entry) === key(name))
    ? normalizeTagNames(selected.filter((entry) => key(entry) !== key(name)), existing)
    : normalizeTagNames([...selected, name], existing);
}

export function matchingTagNames(existing: readonly string[], query: string): string[] {
  const normalized = key(query);
  return normalizeTagNames(existing)
    .filter((name) => key(name).includes(normalized))
    .sort((a, b) => a.localeCompare(b, "zh-CN", { sensitivity: "base", numeric: true }));
}
