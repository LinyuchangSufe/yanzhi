import { useEffect, useRef } from "react";
import { subscribeLibraryEvents } from "../../lib/editor/library-events";

/** Only reload saved server state; each editor keeps its own unsaved draft. */
export function useLibrarySync(refresh: () => Promise<void>, navigate?: (href: string) => void) {
  const latest = useRef({ refresh, navigate });
  latest.current = { refresh, navigate };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void latest.current.refresh(); }, 80);
    };
    const visibility = () => { if (document.visibilityState === "visible") schedule(); };
    const unsubscribe = subscribeLibraryEvents((event) => {
      if (event.type === "changed") schedule();
      else latest.current.navigate?.(event.href);
    });
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
}
