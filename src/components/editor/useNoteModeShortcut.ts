import { useEffect, useRef, type RefObject } from "react";

/** Capture before CodeMirror's Mod-Enter binding can insert a blank line. */
export function useNoteModeShortcut(
  root: RefObject<HTMLElement | null>,
  toggle: () => void,
) {
  const latest = useRef(toggle);
  latest.current = toggle;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const doc = element.ownerDocument;
    const surface = doc.defaultView;
    if (!surface) return;
    const handle = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented || event.key !== "Enter" ||
        event.metaKey === event.ctrlKey || event.altKey || event.shiftKey ||
        event.isComposing || event.keyCode === 229 ||
        !element.getClientRects().length
      ) return;
      // Search, dialogs and AI controls keep their own keyboard behavior.
      if ([...doc.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')]
        .some((dialog) => dialog.getClientRects().length)) return;
      const target = event.target instanceof Element ? event.target : doc.activeElement;
      if (target?.closest('[data-note-shortcuts="ignore"], .cm-panels')) return;
      const field = target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
      if (field && !element.contains(field)) return;
      event.preventDefault();
      event.stopPropagation();
      // Consume held repeats too, so they cannot reach CodeMirror after switching.
      if (!event.repeat) latest.current();
    };
    surface.addEventListener("keydown", handle, true);
    return () => surface.removeEventListener("keydown", handle, true);
  }, [root]);
}
