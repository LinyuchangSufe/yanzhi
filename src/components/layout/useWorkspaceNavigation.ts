"use client";

import { useCallback, useEffect, useRef, useState, type RefObject, type SetStateAction } from "react";
import type { KBState } from "../../lib/types";
import { rememberOpenedPaper } from "../../lib/library-navigation";
import { isWorkspaceLink, storedWorkspaceLocation, workspaceHref, workspaceLocation, type WorkspaceLocation } from "../../lib/workspace-navigation";
import type { NoteEditorHandle, NoteEditorPosition } from "../NoteEditor";
import type { Section, Tab, View } from "../WorkspaceShared";

interface ReturnLocation extends WorkspaceLocation {
  scrollTop: number;
  editorPosition?: NoteEditorPosition;
}
interface Options {
  state: KBState | null;
  stateRef: RefObject<KBState | null>;
  beforeLeave: () => Promise<boolean>;
  mainRef: RefObject<HTMLElement | null>;
  editor: RefObject<NoteEditorHandle | null>;
  deepLink: RefObject<((href: string) => Promise<void>) | null>;
  onNavigate: (match: string) => void;
  onMissing: () => void;
}

function readReturn(value: unknown): ReturnLocation | null {
  const location = storedWorkspaceLocation(value);
  if (!location) return null;
  const raw = value as Record<string, unknown>;
  const position = raw.editorPosition as Partial<NoteEditorPosition> | undefined;
  const editorPosition = position && (position.mode === "edit" || position.mode === "preview") &&
    Number.isSafeInteger(position.from) && Number.isSafeInteger(position.to) &&
    (position.from ?? -1) >= 0 && (position.to ?? -1) >= 0 &&
    typeof position.scrollTop === "number" && Number.isFinite(position.scrollTop)
      ? position as NoteEditorPosition : undefined;
  return { ...location, scrollTop: typeof raw.scrollTop === "number" && Number.isFinite(raw.scrollTop) ? Math.max(0, raw.scrollTop) : 0, editorPosition };
}

/** App navigation stays in the current document; native history also restores it on reload. */
export function useWorkspaceNavigation(options: Options) {
  const [view, setView] = useState<View>({ kind: "home" });
  const [section, setSectionState] = useState<Section>("all");
  const [tab, setTab] = useState<Tab>("notes");
  const [referenceReturn, setReferenceReturn] = useState<ReturnLocation | null>(null);
  const [settingsReturn, setSettingsReturn] = useState<ReturnLocation | null>(null);
  const [initialized, setInitialized] = useState(false);
  const latest = useRef(options);
  latest.current = options;
  const current = useRef<WorkspaceLocation>({ view, section, tab });
  current.current = { view, section, tab };
  const replaceNext = useRef(true);
  const generation = useRef(0);
  const initializedRef = useRef(false);
  const listScroll = useRef(0);
  const pendingRestore = useRef<ReturnLocation | null>(null);
  const positions = useRef(new Map<string, ReturnLocation>());
  const restoring = useRef(false);
  const setSection = useCallback((next: SetStateAction<Section>) => {
    const value = typeof next === "function" ? next(current.current.section) : next;
    current.current = { ...current.current, section: value };
    setSectionState(value);
  }, []);

  const snapshot = useCallback((): ReturnLocation => ({
    ...current.current,
    scrollTop: latest.current.mainRef.current?.scrollTop || 0,
    editorPosition: latest.current.editor.current?.capturePosition(),
  }), []);

  const changeTab = useCallback((next: SetStateAction<Tab>) => {
    const value = typeof next === "function" ? next(current.current.tab) : next;
    if (value === current.current.tab) return;
    const previous = snapshot();
    const previousHref = workspaceHref(previous, window.location.pathname);
    positions.current.set(previousHref, previous);
    window.history.replaceState({ ...window.history.state, kbPosition: previous }, "", previousHref);
    const location = { ...current.current, tab: value };
    pendingRestore.current = positions.current.get(workspaceHref(location, window.location.pathname)) ?? null;
    current.current = location;
    setTab(value);
  }, [snapshot]);

  const available = useCallback((location: WorkspaceLocation): WorkspaceLocation => {
    const target = location.view;
    const data = latest.current.stateRef.current;
    if (target.kind === "home" || !data) return location;
    const found = target.kind === "paper" ? data.papers.some((item) => item.id === target.id)
      : target.kind === "topic" ? data.topics.some((item) => item.id === target.id)
      : target.kind === "discussion" ? (data.externalDiscussions ?? []).some((item) => item.id === target.id)
      : data.notes.some((item) => item.id === target.id);
    if (found) return location;
    latest.current.onMissing();
    return { view: { kind: "home" }, section: "all", tab: "notes" };
  }, []);

  const navigate = useCallback(async (next: View, nextTab: Tab = "notes", match = "", nextSection?: Section) => {
    const request = ++generation.current;
    restoring.current = false;
    if (!(await latest.current.beforeLeave()) || request !== generation.current) return false;
    const previous = snapshot();
    const previousHref = workspaceHref(previous, window.location.pathname);
    positions.current.set(previousHref, previous);
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` === previousHref)
      window.history.replaceState({ ...window.history.state, kbPosition: previous }, "", previousHref);
    if (current.current.view.kind === "home") listScroll.current = previous.scrollTop;
    const location = available({ view: next, tab: nextTab, section: nextSection ?? current.current.section });
    current.current = location;
    setView(location.view);
    setTab(location.tab);
    setSectionState(location.section);
    latest.current.onNavigate(match);
    if (next.kind === "paper") {
      try {
        localStorage.setItem("research-recent", JSON.stringify(rememberOpenedPaper(localStorage.getItem("research-recent"), next.id, latest.current.state?.papers || [])));
      } catch { /* Private browser storage must not block navigation. */ }
    }
    requestAnimationFrame(() => {
      if (latest.current.mainRef.current) latest.current.mainRef.current.scrollTop = next.kind === "home" ? listScroll.current : 0;
    });
    return true;
  }, [snapshot, available]);

  const chooseSection = useCallback(async (next: Section) => {
    const previous = snapshot();
    if (!(await navigate({ kind: "home" }, "notes", "", next))) return false;
    if (next === "reference" && !(previous.view.kind === "home" && previous.section === "reference")) setReferenceReturn(previous);
    if (next === "settings" && !(previous.view.kind === "home" && previous.section === "settings")) setSettingsReturn(previous);
    return true;
  }, [navigate, snapshot]);

  const returnTo = useCallback(async (location: ReturnLocation | null) => {
    if (!location) return;
    pendingRestore.current = location;
    if (!(await navigate(location.view, location.tab, "", location.section))) pendingRestore.current = null;
  }, [navigate]);
  useEffect(() => {
    const pending = pendingRestore.current;
    if (!pending) return;
    pendingRestore.current = null;
    requestAnimationFrame(() => {
      if (latest.current.mainRef.current) latest.current.mainRef.current.scrollTop = pending.scrollTop;
      if (pending.editorPosition) latest.current.editor.current?.restorePosition(pending.editorPosition);
    });
  }, [view, section, tab]);

  useEffect(() => {
    if (!options.state || initializedRef.current) return;
    initializedRef.current = true;
    const initialize = async () => {
      setSettingsReturn(readReturn(window.history.state?.kbSettingsReturn));
      setReferenceReturn(readReturn(window.history.state?.kbReferenceReturn));
      pendingRestore.current = readReturn(window.history.state?.kbPosition);
      if (isWorkspaceLink(window.location.hash)) await latest.current.deepLink.current?.(window.location.hash);
      else {
        const location = available(workspaceLocation(window.location.search));
        pendingRestore.current = readReturn(window.history.state?.kbPosition) || positions.current.get(workspaceHref(location, window.location.pathname)) || null;
        current.current = location;
        setView(location.view);
        setSectionState(location.section);
        setTab(location.tab);
      }
      setInitialized(true);
    };
    void initialize();
  }, [Boolean(options.state)]);

  useEffect(() => {
    if (!initialized || restoring.current) return;
    const href = workspaceHref({ view, section, tab }, window.location.pathname);
    const actual = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const entry = { ...window.history.state, kbPosition: href === actual ? window.history.state?.kbPosition : undefined, kbSettingsReturn: settingsReturn, kbReferenceReturn: referenceReturn };
    if (href !== actual) {
      window.history[replaceNext.current ? "replaceState" : "pushState"](entry, "", href);
    } else window.history.replaceState(entry, "", href);
    replaceNext.current = false;
  }, [initialized, view, section, tab, settingsReturn, referenceReturn]);

  useEffect(() => {
    if (!initialized) return;
    let handled = "";
    const restore = async () => {
      const href = window.location.href;
      if (handled === href) return;
      handled = href;
      const request = ++generation.current;
      positions.current.set(workspaceHref(current.current, window.location.pathname), snapshot());
      restoring.current = true;
      if (!(await latest.current.beforeLeave()) || request !== generation.current) {
        if (request === generation.current) {
          window.history.replaceState(window.history.state, "", workspaceHref(current.current, window.location.pathname));
          restoring.current = false;
          handled = "";
        }
        return;
      }
      replaceNext.current = true;
      if (isWorkspaceLink(window.location.hash)) await latest.current.deepLink.current?.(window.location.hash);
      else {
        const location = available(workspaceLocation(window.location.search));
        pendingRestore.current = readReturn(window.history.state?.kbPosition) || positions.current.get(workspaceHref(location, window.location.pathname)) || null;
        current.current = location;
        setView(location.view);
        setSectionState(location.section);
        setTab(location.tab);
        latest.current.onNavigate("");
        setSettingsReturn(readReturn(window.history.state?.kbSettingsReturn));
        setReferenceReturn(readReturn(window.history.state?.kbReferenceReturn));
      }
      restoring.current = false;
      handled = "";
    };
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
    };
  }, [initialized]);

  return {
    view, section, tab, setView, setSection, setTab: changeTab, navigate, chooseSection,
    referenceReturn, settingsReturn,
    returnFromReference: () => returnTo(referenceReturn),
    returnFromSettings: () => returnTo(settingsReturn),
  };
}
