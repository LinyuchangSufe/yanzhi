import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const STORAGE_KEY = "research-idea-workspace-split";
const DEFAULT_SPLIT = 50;
const HANDLE_WIDTH = 12;
const MIN_PANE_WIDTH = 360;
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

export function ideaSplitLimits(width: number) {
  const available = Math.max(0, width - HANDLE_WIDTH);
  const minimum = available ? Math.max(35, Math.min(50, (MIN_PANE_WIDTH / available) * 100)) : 35;
  return { minimum, maximum: 100 - minimum };
}

/** Keep layout preferences in this browser; adjusting a panel never writes research data. */
export function useIdeaSplit() {
  const containerRef = useRef<HTMLDivElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState(DEFAULT_SPLIT);
  const [limits, setLimits] = useState({ minimum: 35, maximum: 65 });
  const [desktop, setDesktop] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pointer = useRef<number | null>(null);
  const preference = useRef(DEFAULT_SPLIT);
  const bounds = useRef(limits);
  bounds.current = limits;
  const split = clamp(preferred, limits.minimum, limits.maximum);
  const change = (value: number) => {
    const next = clamp(value, bounds.current.minimum, bounds.current.maximum);
    preference.current = next; setPreferred(next);
  };
  const save = () => {
    try { window.localStorage.setItem(STORAGE_KEY, String(preference.current)); } catch { /* Resizing also works without browser storage. */ }
  };
  const finish = () => {
    const id = pointer.current;
    if (id === null) return;
    pointer.current = null; setDragging(false); save();
    const separator = separatorRef.current;
    if (separator?.hasPointerCapture(id)) separator.releasePointerCapture(id);
  };

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored !== null && stored.trim() && Number.isFinite(Number(stored))) {
        const value = clamp(Number(stored), 35, 65);
        preference.current = value; setPreferred(value);
      }
    } catch { /* The default ratio remains available. */ }
    const media = window.matchMedia("(min-width: 1001px)");
    const sync = () => {
      setDesktop(media.matches);
      if (!media.matches) {
        finish();
        if (document.activeElement === separatorRef.current) separatorRef.current?.blur();
      }
      const width = containerRef.current?.getBoundingClientRect().width ?? 0;
      const next = ideaSplitLimits(width);
      bounds.current = next; setLimits(next);
    };
    sync(); media.addEventListener("change", sync);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    if (containerRef.current) observer?.observe(containerRef.current);
    window.addEventListener("resize", sync);
    window.addEventListener("blur", finish);
    return () => {
      media.removeEventListener("change", sync); observer?.disconnect(); window.removeEventListener("resize", sync); window.removeEventListener("blur", finish);
      const id = pointer.current; pointer.current = null;
      const separator = separatorRef.current;
      if (id !== null && separator?.hasPointerCapture(id)) separator.releasePointerCapture(id);
      if (id !== null) save();
    };
  }, []);
  useEffect(() => {
    containerRef.current?.style.setProperty("--idea-discussion-share", `${split}fr`);
    containerRef.current?.style.setProperty("--idea-note-share", `${100 - split}fr`);
  }, [split]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!desktop || !event.isPrimary || event.button !== 0 || pointer.current !== null) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = event.pointerId; setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== event.pointerId) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect && rect.width > HANDLE_WIDTH) change(((event.clientX - rect.left - HANDLE_WIDTH / 2) / (rect.width - HANDLE_WIDTH)) * 100);
  };
  const onPointerFinish = (event: PointerEvent<HTMLDivElement>) => { if (pointer.current === event.pointerId) finish(); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!desktop || event.altKey || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing) return;
    const value = event.key === "ArrowLeft" ? split - 2 : event.key === "ArrowRight" ? split + 2
      : event.key === "Home" ? limits.minimum : event.key === "End" ? limits.maximum : null;
    if (value === null) return;
    event.preventDefault(); change(value); save();
  };
  const reset = () => { change(DEFAULT_SPLIT); save(); };
  return { containerRef, separatorRef, split, limits, desktop, dragging, onPointerDown, onPointerMove, onPointerFinish, onKeyDown, reset };
}
