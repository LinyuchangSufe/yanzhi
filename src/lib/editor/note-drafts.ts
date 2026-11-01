export interface NoteDraft {
  title: string;
  body: string;
  revision: number;
  updatedAt?: number;
}

let session: { document: Document; id: string } | null = null;

/** A fresh page has its own draft slot, including a detached editor window. */
export function editorSessionId(): string {
  if (typeof document === "undefined") return "server";
  if (!session || session.document !== document)
    session = { document, id: crypto.randomUUID() };
  return session.id;
}

export function draftKey(noteId: string, sessionId: string): string {
  return `research-note-draft:${noteId}:${sessionId}`;
}

export function writeDraft(
  storage: Storage,
  key: string,
  value: NoteDraft,
): void {
  storage.setItem(key, JSON.stringify({ ...value, updatedAt: Date.now() }));
}

function parseDraft(raw: string | null): NoteDraft | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.title !== "string" ||
      typeof record.body !== "string" ||
      typeof record.revision !== "number" ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 1
    )
      return null;
    return {
      title: record.title,
      body: record.body,
      revision: record.revision,
      ...(typeof record.updatedAt === "number" &&
      Number.isFinite(record.updatedAt) &&
      record.updatedAt >= 0
        ? { updatedAt: record.updatedAt }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Reading only offers recovery; it never applies or removes another draft. */
export function readRecoveryDraft(
  storage: Storage,
  noteId: string,
  saved: { title: string; body: string },
): { key: string; value: NoteDraft } | null {
  const legacyKey = `research-note-draft:${noteId}`;
  const prefix = `${legacyKey}:`;
  const keys = new Set<string>([legacyKey]);
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    if (suffix && !suffix.includes(":")) keys.add(key);
  }
  let latest: { key: string; value: NoteDraft } | null = null;
  // Stable ties avoid changing the offered draft if storage enumeration changes.
  for (const key of [...keys].sort()) {
    const value = parseDraft(storage.getItem(key));
    if (
      !value ||
      (value.title === saved.title && value.body === saved.body)
    )
      continue;
    if (!latest || (value.updatedAt ?? 0) >= (latest.value.updatedAt ?? 0))
      latest = { key, value };
  }
  return latest;
}

/** A completed save must not erase edits written while the request was pending. */
export function clearMatchingDraft(
  storage: Storage,
  key: string,
  expected: { title: string; body: string; revision: number },
): void {
  const value = parseDraft(storage.getItem(key));
  if (
    value &&
    value.title === expected.title &&
    value.body === expected.body &&
    value.revision === expected.revision
  )
    storage.removeItem(key);
}
