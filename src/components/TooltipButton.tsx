"use client";

import { forwardRef, useEffect, useId, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { createPortal } from "react-dom";
import styles from "./TooltipButton.module.css";

type Props = ComponentPropsWithoutRef<"button"> & { tooltip?: string };

/** A regular button with the same explanation for pointer and keyboard users. */
const TooltipButton = forwardRef<HTMLButtonElement, Props>(function TooltipButton(
  { tooltip, title, onPointerEnter, onPointerLeave, onFocus, onBlur, onClick, children, ...props },
  forwardedRef,
) {
  const button = useRef<HTMLButtonElement | null>(null);
  const tip = useRef<HTMLDivElement | null>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const explanation = tooltip ?? title ?? props["aria-label"];

  useEffect(() => {
    if (!open) return;
    const position = () => {
      if (!button.current || !tip.current) return;
      const bounds = button.current.getBoundingClientRect();
      const size = tip.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(window.innerWidth - size.width - 8, bounds.left + (bounds.width - size.width) / 2));
      const above = bounds.top - size.height - 8;
      // Coordinates depend on the current trigger, while visual styling lives in CSS.
      tip.current.style.setProperty("--tooltip-left", `${left}px`);
      tip.current.style.setProperty("--tooltip-top", `${above >= 8 ? above : Math.min(window.innerHeight - size.height - 8, bounds.bottom + 8)}px`);
      tip.current.dataset.positioned = "true";
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    document.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      document.removeEventListener("keydown", dismiss);
    };
  }, [open, explanation]);

  return <>
    <button {...props} title={title}
      ref={(element) => {
        button.current = element;
        if (typeof forwardedRef === "function") forwardedRef(element);
        else if (forwardedRef) forwardedRef.current = element;
      }}
      aria-describedby={[props["aria-describedby"], open && explanation ? id : ""].filter(Boolean).join(" ") || undefined}
      onPointerEnter={(event) => { onPointerEnter?.(event); if (explanation) setOpen(true); }}
      onPointerLeave={(event) => { onPointerLeave?.(event); setOpen(false); }}
      onFocus={(event) => { onFocus?.(event); if (explanation && !props.disabled) setOpen(true); }}
      onBlur={(event) => { onBlur?.(event); setOpen(false); }}
      onClick={(event) => { setOpen(false); onClick?.(event); }}
    >{children}</button>
    {open && explanation && createPortal(
      <div id={id} ref={tip} role="tooltip" className={styles.tooltip}>{explanation}</div>,
      document.body,
    )}
  </>;
});

export default TooltipButton;
