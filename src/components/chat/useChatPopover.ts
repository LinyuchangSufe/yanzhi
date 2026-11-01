import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

const focusable = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]';
const visible = (element: HTMLElement) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";

/** Positions a body portal without depending on an ancestor's overflow rules. */
export function useChatPopover() {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
  }, []);
  const show = useCallback(() => setOpen(true), []);
  useEffect(() => {
    if (!open) return;
    let positionFrame = 0, focusFrame = 0;
    const position = () => {
      const button = trigger.current, menu = panel.current;
      if (!button || !menu) return;
      const rect = button.getBoundingClientRect();
      const below = Math.max(0, window.innerHeight - rect.bottom - 14);
      const above = Math.max(0, rect.top - 14);
      const placeAbove = below < Math.min(menu.scrollHeight, 280) && above > below;
      menu.style.setProperty("--chat-popover-max-height", `${Math.max(32, placeAbove ? above : below)}px`);
      const size = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(window.innerWidth - size.width - 8, rect.left));
      const top = Math.max(8, Math.min(window.innerHeight - size.height - 8, placeAbove ? rect.top - size.height - 6 : rect.bottom + 6));
      menu.style.setProperty("--chat-popover-left", `${left}px`);
      menu.style.setProperty("--chat-popover-top", `${top}px`);
      menu.dataset.positioned = "true";
    };
    const schedule = () => { window.cancelAnimationFrame(positionFrame); positionFrame = window.requestAnimationFrame(position); };
    const moveAfterTrigger = () => {
      const outsideElements = [...document.querySelectorAll<HTMLElement>(focusable)].filter((element) =>
        element.tabIndex >= 0 && visible(element) && !panel.current?.contains(element));
      const next = outsideElements[outsideElements.indexOf(trigger.current!) + 1];
      close(false); (next ?? trigger.current)?.focus({ preventScroll: true });
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) close();
    };
    const focusOutside = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(false);
    };
    const keys = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== "Tab" || !panel.current?.contains(document.activeElement)) return;
      const elements = [...panel.current.querySelectorAll<HTMLElement>(focusable)].filter((element) => element.tabIndex >= 0 && visible(element));
      const current = document.activeElement;
      if ((event.shiftKey && (current === elements[0] || !elements.includes(current as HTMLElement))) ||
          (!event.shiftKey && current === elements.at(-1))) {
        event.preventDefault();
        if (event.shiftKey) { close(); return; }
        moveAfterTrigger();
      } else if (!event.shiftKey && !elements.includes(current as HTMLElement)) {
        const next = elements.find((element) => element.getAttribute("role") !== "option");
        event.preventDefault();
        if (next) next.focus();
        else moveAfterTrigger();
      }
    };
    position();
    focusFrame = window.requestAnimationFrame(() => {
      const menu = panel.current;
      const initial = menu?.querySelector<HTMLElement>('[data-selected="true"]:not(:disabled)') ?? menu?.querySelector<HTMLElement>('[data-chat-initial-focus]:not(:disabled)') ?? menu;
      initial?.focus({ preventScroll: true }); initial?.scrollIntoView({ block: "nearest" });
    });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (panel.current) observer?.observe(panel.current);
    window.addEventListener("resize", schedule); window.addEventListener("scroll", schedule, true);
    document.addEventListener("pointerdown", outside, true); document.addEventListener("focusin", focusOutside);
    document.addEventListener("keydown", keys, true);
    return () => {
      window.cancelAnimationFrame(positionFrame); window.cancelAnimationFrame(focusFrame); observer?.disconnect();
      window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", focusOutside);
      document.removeEventListener("keydown", keys, true);
    };
  }, [open, close]);
  return { id, trigger, panel, open, show, close };
}

export function moveChatOptionFocus(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey ||
      !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')];
  if (!options.length || !(event.target instanceof HTMLButtonElement)) return;
  const index = options.indexOf(event.target);
  if (index < 0) return;
  const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
    : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
  event.preventDefault(); options[next].focus(); options[next].scrollIntoView({ block: "nearest" });
}
