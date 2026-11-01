"use client";

import { CircleAlert, CircleCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import styles from "./styles/WorkspaceNotice.module.css";

interface Props {
  error: string;
  message: string;
  onDismissMessage: () => void;
  onClose: () => void;
}

/** Routine notices expire; failures remain visible until explicitly dismissed. */
export default function WorkspaceNotice({ error, message, onDismissMessage, onClose }: Props) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const dismissMessage = useRef(onDismissMessage);
  dismissMessage.current = onDismissMessage;

  useEffect(() => {
    if (error || hovered || focused || !message) return;
    const timer = window.setTimeout(() => dismissMessage.current(), 5_000);
    return () => window.clearTimeout(timer);
  }, [error, message, hovered, focused]);

  return (
    <div className={`${styles.notice} ${error ? styles.error : ""}`}
      role={error ? "alert" : "status"} aria-atomic="true"
      onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}>
      {error ? <CircleAlert size={17} aria-hidden="true" /> : <CircleCheck size={17} aria-hidden="true" />}
      <span>{error || message}</span>
      <button type="button" className={styles.close} aria-label="关闭提示" title="关闭提示" onClick={onClose}>
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
