"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import type { PaperChatConfiguration } from "../../lib/paper-chat/types";
import { moveChatOptionFocus, useChatPopover } from "./useChatPopover";
import styles from "./ChatModelPicker.module.css";

export interface ChatModelPickerProps {
  scopeLabel: string;
  configuration: PaperChatConfiguration | null;
  modelOverride: string;
  modelOptions: { id: string; label: string }[];
  modelOptionsLoading: boolean;
  modelOptionsWarning: string;
  modelNotice: string;
  runningModel?: string | null;
  onOpen: () => void | Promise<void>;
  onSetModel: (model: string) => boolean;
  onRefresh: () => void | Promise<void>;
  onSettings?: () => void;
}
const friendlyModel = (model: string) => model === "cli-default" ? "CLI 默认模型" : model || "未设置";

export default function ChatModelPicker({ scopeLabel, configuration, modelOverride, modelOptions, modelOptionsLoading,
  modelOptionsWarning, modelNotice, runningModel, onOpen, onSetModel, onRefresh, onSettings }: ChatModelPickerProps) {
  const popover = useChatPopover();
  const [draft, setDraft] = useState(modelOverride);
  const [editing, setEditing] = useState(false);
  const [failure, setFailure] = useState("");
  const [loadFailure, setLoadFailure] = useState("");
  useEffect(() => { if (!editing) setDraft(modelOverride); }, [modelOverride, editing]);
  const current = modelOverride || configuration?.model || "";
  const display = current === "cli-default" ? friendlyModel(current) : modelOptions.find((option) => option.id === current)?.label || friendlyModel(current);
  const defaultDisplay = friendlyModel(configuration?.model || "");
  const read = async (action: () => void | Promise<void>) => {
    setLoadFailure("");
    try { await action(); } catch (error) { setLoadFailure(error instanceof Error ? error.message : "暂时无法读取模型目录，可在高级选项中重试。"); }
  };
  const open = () => {
    if (popover.open) { popover.close(); return; }
    setFailure(""); popover.show(); void read(onOpen);
  };
  const select = (value: string) => {
    try {
      if (onSetModel(value)) { setDraft(value); setEditing(false); setFailure(""); popover.close(); }
      else setFailure("模型尚未更新，请检查输入或配置提示后重试。");
    } catch (error) { setFailure(error instanceof Error ? error.message : "模型未更新，请重试。"); }
  };
  const custom = modelOverride && !modelOptions.some((option) => option.id === modelOverride);
  return <div className={styles.picker}>
    <button type="button" ref={popover.trigger} className={styles.trigger} aria-haspopup="dialog" aria-expanded={popover.open}
      aria-controls={popover.open ? popover.id : undefined} aria-label={`${scopeLabel}模型：${display}`} title={`选择${scopeLabel}下次使用的模型：${display}`}
      onClick={open} onKeyDown={(event) => { if (event.key === "ArrowDown" && !popover.open && !event.nativeEvent.isComposing) { event.preventDefault(); open(); } }}>
      <span className={styles.modelName}>模型：{display}</span><ChevronDown size={13} aria-hidden="true" />
    </button>
    {popover.open && createPortal(<div id={popover.id} ref={popover.panel} role="dialog" aria-label={`${scopeLabel}模型选择`}
      className={styles.menu} tabIndex={-1}>
      <div className={styles.menuHeader}><strong>选择模型</strong><span>用于下次发送或整理</span></div>
      <div className={styles.menuBody}>
        <div className={styles.catalog} role="listbox" aria-label={`${scopeLabel}模型目录`} onKeyDown={moveChatOptionFocus}>
          <button type="button" role="option" className={styles.option} aria-selected={!modelOverride} data-selected={!modelOverride || undefined}
            data-chat-initial-focus disabled={!configuration} tabIndex={!modelOverride ? 0 : -1} onClick={() => select("")}>
            <span><strong>跟随全局默认</strong><small>{defaultDisplay}</small></span>{!modelOverride && <Check size={15} aria-hidden="true" />}
          </button>
          {custom && <button type="button" role="option" className={styles.option} aria-selected data-selected="true" tabIndex={0}
            disabled={!configuration} onClick={() => select(modelOverride)}><span><strong>{friendlyModel(modelOverride)}</strong><small>当前自定义模型</small></span><Check size={15} aria-hidden="true" /></button>}
          {modelOptions.map((option) => <button type="button" key={option.id} role="option" className={styles.option} aria-selected={modelOverride === option.id}
            data-selected={modelOverride === option.id || undefined} tabIndex={modelOverride === option.id ? 0 : -1} disabled={!configuration} onClick={() => select(option.id)}>
            <span><strong>{option.id === "cli-default" ? friendlyModel(option.id) : option.label || option.id}</strong>
              {option.label && option.label !== option.id && option.id !== "cli-default" && <small>{option.id}</small>}</span>
            {modelOverride === option.id && <Check size={15} aria-hidden="true" />}
          </button>)}
        </div>
        {modelOptionsLoading && <p className={styles.hint} role="status">正在读取模型目录…</p>}
        {!modelOptionsLoading && !modelOptions.length && !modelOptionsWarning && !loadFailure && <p className={styles.hint}>服务尚未提供模型目录，可在高级选项中填写模型 ID。</p>}
        {(modelOptionsWarning || loadFailure) && <p className={styles.hint} role="status">{loadFailure || modelOptionsWarning}</p>}
        {(modelNotice || failure) && <p className={styles.notice} role="status">{modelNotice || failure}</p>}
        {runningModel && <p className={styles.hint}>本次仍使用 {friendlyModel(runningModel)}；切换只影响接下来的请求。</p>}
        <details className={styles.advanced}><summary>高级选项</summary>
          <form onSubmit={(event) => { event.preventDefault(); select(draft.trim()); }}>
            <label>模型 ID<input aria-label={`${scopeLabel}自定义模型 ID`} value={draft} maxLength={300} placeholder="留空跟随全局默认"
              onChange={(event) => { setDraft(event.target.value); setEditing(true); setFailure(""); }} /></label>
            <button type="submit" className={styles.action} disabled={!configuration}>应用模型</button>
          </form>
          <div className={styles.advancedActions}><button type="button" className={styles.action} disabled={modelOptionsLoading} onClick={() => void read(onRefresh)}>
            {modelOptionsLoading ? "正在读取…" : "刷新模型目录"}</button>
            {onSettings && <button type="button" className={styles.action} onClick={() => { popover.close(); onSettings(); }}>全局 AI 设置</button>}</div>
          <p className={styles.hint}>这里仅为{scopeLabel}选择模型，不改变全局默认设置。</p>
        </details>
      </div>
    </div>, document.body)}
  </div>;
}
