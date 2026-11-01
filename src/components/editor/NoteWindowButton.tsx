"use client";
import { ExternalLink, PictureInPicture2 } from "lucide-react";
import { useState } from "react";
import { openNoteWindow } from "../../lib/editor/note-window";
import TooltipButton from "../TooltipButton";
import styles from "../styles/NoteWindow.module.css";

export default function NoteWindowButton({ noteId, prepare, disabled }: {
  noteId: string; prepare: () => Promise<void>; disabled?: boolean;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const open = async (ordinary = false) => {
    setOpening(true);
    setError("");
    try { await openNoteWindow(noteId, prepare, { ordinary }); }
    catch (error) { setError(error instanceof Error ? error.message : "独立窗口打开失败，请重试。"); }
    finally { setOpening(false); }
  };
  return <>
    <TooltipButton type="button" className={styles.windowButton} aria-label="独立窗口编辑"
      title="独立窗口编辑；支持时使用置顶画中画，否则打开普通窗口"
      disabled={disabled || opening} onClick={() => void open()}>
      <PictureInPicture2 size={16} aria-hidden="true" /><span>独立窗口</span>
    </TooltipButton>
    {error && <div className={styles.openError} role="alert">
      <span>{error}</span>
      <button type="button" disabled={opening || disabled} onClick={() => void open(true)}>
        <ExternalLink size={14} aria-hidden="true" />普通窗口
      </button>
      <button type="button" onClick={() => setError("")}>关闭提示</button>
    </div>}
  </>;
}
