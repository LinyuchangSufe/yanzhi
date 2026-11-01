"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import TooltipButton from "../TooltipButton";
import styles from "./WorkspaceShortcuts.module.css";

const shortcuts = [
  ["⌘ / Ctrl + K", "搜索知识库"],
  ["⌘ / Ctrl + S", "立即保存当前笔记"],
  ["Ctrl + M", "在笔记中插入行内公式（Mac 也用 Control）"],
  ["⌘ / Ctrl + Enter", "笔记中切换编辑 / 预览；对话输入框中发送"],
  ["[[", "在笔记中搜索并引用文献"],
  ["Esc", "关闭当前菜单、搜索或面板"],
  ["↑ / ↓ / Home / End", "在文献操作菜单中移动"],
  ["← / →", "切换论文标签；聚焦桌面分隔条时调整宽度"],
];

export function WorkspaceShortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return (
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="workspace-shortcuts-title"
      onCancel={onClose} onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={styles.body}>
        <header>
          <h2 id="workspace-shortcuts-title">快捷键</h2>
          <TooltipButton tooltip="关闭快捷键" aria-label="关闭快捷键" onClick={onClose}><X size={18} /></TooltipButton>
        </header>
        <p>⌘ 用于 Mac；Ctrl 用于 Windows / Linux。输入法选字时不会触发快捷键。</p>
        <dl>{shortcuts.map(([keys, description]) => <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{description}</dd></div>)}</dl>
        <p>保存仅针对当前笔记。AI 配置和批注请使用各自的保存按钮。</p>
      </div>
    </dialog>
  );
}
