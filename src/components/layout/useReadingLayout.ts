"use client";
import { useCallback, useEffect, useRef, useState } from "react";

interface Preferences {
  sidebarCollapsed: boolean;
  topbarCollapsed: boolean;
  headingCollapsed: boolean;
  notesCollapsed: boolean;
}
const defaults: Preferences = {
  sidebarCollapsed: false,
  topbarCollapsed: false,
  headingCollapsed: false,
  notesCollapsed: false,
};
const storageKey = "research-reading-layout-v1";

/** Focus is a temporary overlay; the four independent preferences survive exit and reload. */
export function useReadingLayout(
  beforeHide: () => Promise<boolean>,
  paperOpen: boolean,
) {
  const [preferences, setPreferences] = useState<Preferences>(defaults);
  const [loaded, setLoaded] = useState(false);
  const [focus, setFocus] = useState(false);
  const [changing, setChanging] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const transition = useRef(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 650px)");
    const changed = () => {
      setIsMobile(media.matches);
      setMobileSidebarOpen(false);
    };
    changed();
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
      setPreferences(
        Object.fromEntries(
          Object.entries(defaults).map(([key, fallback]) => [
            key,
            typeof saved[key] === "boolean" ? saved[key] : fallback,
          ]),
        ) as unknown as Preferences,
      );
    } catch {
      /* Layout storage never blocks access to research content. */
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (loaded) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(preferences));
      } catch {}
    }
  }, [loaded, preferences]);
  useEffect(() => {
    if (!paperOpen) setFocus(false);
  }, [paperOpen]);
  const update = useCallback(
    (key: keyof Preferences, value: boolean) =>
      setPreferences((previous) => ({ ...previous, [key]: value })),
    [],
  );
  const revealNotes = useCallback(() => {
    setFocus(false);
    update("notesCollapsed", false);
  }, [update]);
  const guarded = useCallback(
    async (apply: () => void) => {
      if (transition.current) return;
      transition.current = true;
      setChanging(true);
      try {
        if (await beforeHide()) apply();
      } finally {
        transition.current = false;
        setChanging(false);
      }
    },
    [beforeHide],
  );
  const toggleFocus = useCallback(async () => {
    if (focus) {
      setFocus(false);
      return;
    }
    await guarded(() => setFocus(true));
  }, [focus, guarded]);
  const toggleNotes = useCallback(async () => {
    if (focus || preferences.notesCollapsed) {
      revealNotes();
      return;
    }
    await guarded(() => update("notesCollapsed", true));
  }, [focus, preferences.notesCollapsed, guarded, revealNotes, update]);
  return {
    focus,
    changing,
    isMobile,
    mobileSidebarOpen,
    closeMobileSidebar: () => setMobileSidebarOpen(false),
    sidebarHidden: focus || (isMobile ? !mobileSidebarOpen : preferences.sidebarCollapsed),
    topbarHidden: focus || preferences.topbarCollapsed,
    headingHidden: focus || preferences.headingCollapsed,
    notesHidden: focus || preferences.notesCollapsed,
    toggleFocus,
    toggleNotes,
    revealNotes,
    exitFocus: () => setFocus(false),
    toggleSidebar: () => {
      if (isMobile) setMobileSidebarOpen((value) => !value);
      else update("sidebarCollapsed", !preferences.sidebarCollapsed);
    },
    toggleTopbar: () => update("topbarCollapsed", !preferences.topbarCollapsed),
    toggleHeading: () =>
      update("headingCollapsed", !preferences.headingCollapsed),
    showSidebar: () => {
      setFocus(false);
      if (isMobile) setMobileSidebarOpen(true);
      else update("sidebarCollapsed", false);
    },
    showTopbar: () => {
      setFocus(false);
      update("topbarCollapsed", false);
    },
    showHeading: () => {
      setFocus(false);
      update("headingCollapsed", false);
    },
  };
}
