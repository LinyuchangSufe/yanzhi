type LeaveGuard = () => boolean | Promise<boolean>;
const guards = new Set<LeaveGuard>();

/** Editors outside the Markdown pane participate in application navigation. */
export function registerLeaveGuard(guard: LeaveGuard): () => void {
  guards.add(guard);
  return () => { guards.delete(guard); };
}

export async function prepareWorkspaceLeave(): Promise<boolean> {
  for (const guard of [...guards]) {
    if (!(await guard())) return false;
  }
  return true;
}

export function readSessionDraft<T>(
  storage: Pick<Storage, "getItem">,
  key: string,
  validate: (value: unknown) => value is T,
): T | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const record: unknown = JSON.parse(raw);
    if (!record || typeof record !== "object" || !("version" in record) ||
        record.version !== 1 || !("value" in record) || !validate(record.value)) return null;
    return record.value;
  } catch { return null; }
}

export function persistSessionDraft<T>(
  storage: Pick<Storage, "setItem" | "removeItem">,
  key: string,
  value: T,
  dirty: boolean,
): void {
  if (dirty) storage.setItem(key, JSON.stringify({ version: 1, value }));
  else storage.removeItem(key);
}
