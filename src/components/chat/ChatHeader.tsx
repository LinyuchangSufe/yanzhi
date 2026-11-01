"use client";
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, History, Plus } from "lucide-react";
import { moveChatOptionFocus, useChatPopover } from "./useChatPopover";
import styles from "./ChatHeader.module.css";

export interface ChatHeaderProps {
  title: string;
  conversations: { id: string; title: string; createdAt?: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  disabled?: boolean;
  historyDisabled?: boolean;
  modelControl: ReactNode;
  leading?: ReactNode;
  extra?: ReactNode;
  loading?: boolean;
}

export default function ChatHeader({ title, conversations, activeId, onSelect, onNew, disabled = false, historyDisabled = disabled, modelControl, leading, extra, loading = false }: ChatHeaderProps) {
  const popover = useChatPopover();
  const newBlocked = disabled || loading;
  const historyBlocked = historyDisabled || loading;
  useEffect(() => { if (historyBlocked && popover.open) popover.close(); }, [historyBlocked, popover.open, popover.close]);
  const select = (id: string) => { if (historyBlocked || (!id && newBlocked)) return; popover.close(); onSelect(id); };
  const hasCurrent = Boolean(activeId && conversations.some((item) => item.id === activeId));
  return <header className={styles.header} aria-busy={loading || undefined}>
    {leading && <div className={styles.leading}>{leading}</div>}
    <h2 className={styles.title} title={title}>{title}</h2>
    <button type="button" className={styles.historyTrigger} ref={popover.trigger} disabled={historyBlocked} aria-haspopup="dialog" aria-expanded={popover.open}
      aria-controls={popover.open ? popover.id : undefined} aria-label={`${title}历史`} title="选择已保存的对话"
      onClick={() => popover.open ? popover.close() : popover.show()}
      onKeyDown={(event) => { if (event.key === "ArrowDown" && !popover.open && !historyBlocked && !event.nativeEvent.isComposing) { event.preventDefault(); popover.show(); } }}>
      <History size={15} aria-hidden="true" /><span>历史</span>
    </button>
    <div className={styles.modelControl}>{modelControl}</div>
    <button type="button" className={styles.newButton} disabled={newBlocked} onClick={onNew}><Plus size={15} aria-hidden="true" />新对话</button>
    {extra && <div className={styles.extra}>{extra}</div>}
    {popover.open && createPortal(<div className={styles.historyMenu} id={popover.id} ref={popover.panel} role="dialog" aria-label={`${title}历史`} tabIndex={-1}>
      <div className={styles.menuHeading}>对话历史</div>
      <div className={styles.historyList} role="listbox" aria-label={`${title}历史记录`} onKeyDown={moveChatOptionFocus}>
        <button type="button" className={styles.conversation} role="option" disabled={newBlocked} aria-selected={!hasCurrent} data-selected={!hasCurrent || undefined}
          data-chat-initial-focus tabIndex={!hasCurrent && !newBlocked ? 0 : -1} onClick={() => select("")}><span>新的对话</span>{!hasCurrent && <Check size={15} aria-hidden="true" />}</button>
        {conversations.map((conversation) => <button type="button" key={conversation.id} className={styles.conversation} role="option"
          aria-selected={conversation.id === activeId} data-selected={conversation.id === activeId || undefined} tabIndex={conversation.id === activeId ? 0 : -1}
          title={conversation.title} onClick={() => select(conversation.id)}>
          <span>{conversation.title || "未命名对话"}</span>{conversation.id === activeId && <Check size={15} aria-hidden="true" />}
        </button>)}
        {!conversations.length && <p className={styles.empty}>还没有保存的对话。</p>}
      </div>
    </div>, document.body)}
  </header>;
}
