"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { persistSessionDraft, readSessionDraft, registerLeaveGuard } from "../../lib/editor/pending-edits";

/** Session drafts survive tab changes and reload without silently committing edits. */
export function useProtectedDraft<T>({ key, value, dirty, validate, restore, blocked = false }: {
  key: string;
  value: T;
  dirty: boolean;
  validate: (value: unknown) => value is T;
  restore: (value: T) => void;
  blocked?: boolean;
}) {
  const [ready, setReady] = useState(false);
  const [restored, setRestored] = useState(false);
  const [storageError, setStorageError] = useState("");
  const current = useRef({ value, dirty, validate, restore, blocked });
  current.current = { value, dirty, validate, restore, blocked };
  useLayoutEffect(() => {
    try {
      const saved = readSessionDraft(sessionStorage, key, current.current.validate);
      if (saved) { current.current.restore(saved); setRestored(true); }
    } catch { setStorageError("本窗口草稿无法保存；离开前请保存内容。"); }
    setReady(true);
  }, [key]);
  useLayoutEffect(() => {
    if (!ready) return;
    try {
      persistSessionDraft(sessionStorage, key, value, dirty);
      setStorageError("");
    } catch { setStorageError("本窗口草稿无法保存；离开前请保存内容。"); }
  }, [key, value, dirty, ready]);
  useEffect(() => registerLeaveGuard(() => {
    if (current.current.blocked) return false;
    try {
      persistSessionDraft(sessionStorage, key, current.current.value, current.current.dirty);
      return true;
    } catch {
      if (!current.current.dirty) return true;
      setStorageError("本窗口草稿无法保存；请先保存内容再离开。");
      return false;
    }
  }), [key]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!current.current.dirty && !current.current.blocked) return;
      try { persistSessionDraft(sessionStorage, key, current.current.value, current.current.dirty); } catch {}
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [key]);
  return { ready, restored, storageError };
}
