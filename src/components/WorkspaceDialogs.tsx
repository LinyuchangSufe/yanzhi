"use client";
import { Lightbulb, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KBState } from "../lib/types";
import MetadataForm from "./PaperMetadataForm";
import type { WorkspaceController } from "./Workspace";
import {
  citeAnnotation,
  errorMessage,
  linked,
  readResponse,
  type Dialog,
} from "./WorkspaceShared";

import baseStyles from "./Workspace.module.css";
import contentStyles from "./styles/WorkspaceContent.module.css";
const styles = { ...baseStyles, ...contentStyles };

export function WorkspaceDialogs({ c }: { c: WorkspaceController }) {
  const {
    state,
    error,
    dialog,
    busy,
    editor,
    paper,
    view,
    ideas,
    setError,
    setMessage,
    setDialog,
    setBusy,
    mutate,
    leaveEditor,
    navigate,
    createIdea,
    insertInto,
    insertPaperInto,
    uploadPdf,
    changeLink,
  } = c;
  const submission = useRef(0);
  const [linking, setLinking] = useState(false);
  const saveAssociation = async (...args: Parameters<typeof changeLink>) => {
    if (linking) return;
    setLinking(true);
    try { await changeLink(...args); } finally { setLinking(false); }
  };
  const currentDialog = useRef(dialog);
  currentDialog.current = dialog;
  const formDirty = useRef(false);
  const setFormDirty = useCallback((value: boolean) => { formDirty.current = value; }, []);
  useEffect(() => { formDirty.current = false; }, [dialog]);
  const closeDialog = () => {
    if (busy || linking) return;
    if (formDirty.current && !window.confirm("表单有未保存的修改。确定放弃这些修改并关闭？")) return;
    submission.current++;
    formDirty.current = false;
    setDialog(null);
    setBusy(false);
  };
  return (
    <>
      {dialog && (
        <DialogFrame
          title={
            dialog.kind === "paper"
              ? dialog.paper
                ? "编辑文献信息"
                : dialog.citeToNoteId
                  ? "添加文献并引用"
                  : "添加文献"
              : dialog.kind === "paper-trash"
                ? "移入回收站？"
                : dialog.kind === "topic"
                  ? dialog.topic
                    ? "编辑研究问题"
                    : "新建研究问题"
                  : dialog.kind === "idea"
                    ? "新建想法"
                    : dialog.kind === "links"
                      ? "管理关联材料"
                      : dialog.kind === "insert" && dialog.noteId
                        ? "写回综合笔记"
                      : "引用到个人笔记"
          }
          onClose={closeDialog}
          closeDisabled={busy || linking}
        >
          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}
          {dialog.kind === "paper-trash" && (
            <div className={styles.trashConfirmation}>
              <p className={styles.trashTitle}>{dialog.paper.title}</p>
              <p>
                将从全部文献、待阅读和相关论文中隐藏。PDF、个人笔记、批注及关联保留，已有引用仍可打开；之后可以在左栏“回收站”恢复。
              </p>
              <div className={styles.actions}>
                <button disabled={busy} onClick={closeDialog}>
                  取消
                </button>
                <button
                  className={styles.trashConfirmButton}
                  disabled={busy}
                  onClick={async () => {
                    if (await c.changePaperAvailability(dialog.paper, false))
                      setDialog(null);
                  }}
                >
                  {busy ? "正在移入…" : "移入回收站"}
                </button>
              </div>
            </div>
          )}
          {(dialog.kind === "paper" ||
            dialog.kind === "topic" ||
            dialog.kind === "idea") && (
            <MetadataForm
              key={dialog.kind === "paper" ? `paper:${dialog.paper?.id ?? "new"}` :
                dialog.kind === "topic" ? `topic:${dialog.topic?.id ?? "new"}` : dialog.kind}
              dialog={dialog}
              state={state}
              busy={busy}
              onDirtyChange={setFormDirty}
              onCancel={closeDialog}
              onSubmit={async (payload, file) => {
                const token = ++submission.current;
                const live = () =>
                  submission.current === token &&
                  currentDialog.current === dialog;
                setBusy(true);
                setError("");
                try {
                  if (!(await leaveEditor())) return;
                  if (!live()) return;
                  if (dialog.kind === "paper") {
                    const oldIds = new Set(state.papers.map((p) => p.id));
                    const result = await mutate(
                      dialog.paper ? "paper.update" : "paper.create",
                      {
                        ...payload,
                        ...(dialog.paper
                          ? {
                              id: dialog.paper.id,
                              revision: dialog.paper.revision,
                            }
                          : {}),
                      },
                    );
                    if (!live()) return;
                    const id =
                      dialog.paper?.id ||
                      (result.result as { id?: string; paper?: { id: string } })
                        ?.paper?.id ||
                      (result.result as { id?: string })?.id ||
                      result.state.papers.find((p) => !oldIds.has(p.id))?.id;
                    if (!id)
                      throw new Error(
                        "未能确认新文献；请检查文献库是否已有重复条目。",
                      );
                    let attachmentError = "";
                    if (file) {
                      try {
                        await uploadPdf(file, id);
                        if (!live()) return;
                      } catch (error) {
                        if (!live()) return;
                        if (dialog.citeToNoteId) {
                          attachmentError = errorMessage(error);
                        } else {
                          setDialog(null);
                          if (!dialog.paper || view.kind !== "home")
                            await navigate({ kind: "paper", id });
                          setError(
                            `文献已保存。PDF 上传失败：${errorMessage(error)}。可稍后从此记录添加 PDF 附件。`,
                          );
                          return;
                        }
                      }
                    }
                    if (dialog.citeToNoteId) {
                      const cited = result.state.papers.find(
                        (p) => p.id === id,
                      );
                      if (!cited)
                        throw new Error("文献已保存，但未能确认引用目标。");
                      if (
                        await insertPaperInto(dialog.citeToNoteId, cited, live)
                      ) {
                        setDialog(null);
                        if (attachmentError)
                          setError(
                            `文献已保存并插入引用。PDF 上传失败：${attachmentError}。可稍后在文献库添加 PDF。`,
                          );
                        else
                          setMessage("文献已加入库，并插入原笔记的引用位置。");
                      }
                      return;
                    }
                    setDialog(null);
                    if (!dialog.paper || view.kind !== "home")
                      await navigate({ kind: "paper", id });
                  } else if (dialog.kind === "topic") {
                    const oldIds = new Set(state.topics.map((t) => t.id));
                    const result = await mutate(
                      dialog.topic ? "topic.update" : "topic.create",
                      {
                        ...payload,
                        ...(dialog.topic
                          ? {
                              id: dialog.topic.id,
                              revision: dialog.topic.revision,
                            }
                          : {}),
                      },
                    );
                    if (!live()) return;
                    const id =
                      dialog.topic?.id ||
                      result.state.topics.find((t) => !oldIds.has(t.id))?.id;
                    setDialog(null);
                    if (id) await navigate({ kind: "topic", id });
                  } else {
                    const n = await createIdea(
                      String(payload.title),
                      String(payload.body || ""),
                    );
                    if (!live()) return;
                    setDialog(null);
                    if (n) await navigate({ kind: "note", id: n.id });
                  }
                } catch (e) {
                  if (!live()) return;
                  // Recycled records must be explicitly restored before reuse.
                  if ((e as { details?: { trashed?: boolean } })?.details?.trashed) {
                    setError(errorMessage(e));
                    return;
                  }
                  const existing = (
                    e as { details?: { existingPaperId?: string } }
                  )?.details?.existingPaperId;
                  if (existing && dialog.kind === "paper" && !dialog.paper) {
                    if (dialog.citeToNoteId) {
                      let cited = state.papers.find((p) => p.id === existing);
                      if (!cited) {
                        const fresh: KBState = await readResponse(
                          await fetch("/api/kb", { cache: "no-store" }),
                        );
                        if (!live()) return;
                        c.setState(fresh);
                        cited = fresh.papers.find((p) => p.id === existing);
                      }
                      if (!cited) {
                        setError(errorMessage(e));
                        return;
                      }
                      let attachmentError = "";
                      if (file) {
                        try {
                          await uploadPdf(file, existing);
                        } catch (error) {
                          attachmentError = errorMessage(error);
                        }
                        if (!live()) return;
                      }
                      if (
                        await insertPaperInto(dialog.citeToNoteId, cited, live)
                      ) {
                        setDialog(null);
                        if (attachmentError)
                          setError(
                            `已引用文献库的原记录。所选 PDF 上传失败：${attachmentError}。可稍后重新添加。`,
                          );
                        else
                          setMessage(
                            file
                              ? "已引用原记录，并将所选 PDF 添加到该文献。"
                              : "文献库已有相同标识，已引用原记录。",
                          );
                      }
                      return;
                    }
                    setDialog(null);
                    await navigate({ kind: "paper", id: existing });
                    setMessage(
                      "该文献已存在，已打开原有记录。原有元数据、笔记和附件没有覆盖；可在这里添加 PDF 附件。",
                    );
                  } else setError(errorMessage(e));
                } finally {
                  if (submission.current === token) setBusy(false);
                }
              }}
            />
          )}
          {dialog.kind === "links" && (
            <div className={styles.linkManager} aria-busy={linking}>
              <p role="status">{linking ? "正在保存关联…" : "选择即保存。取消勾选只解除关联，不删除材料。"}</p>
              <p>关联用于长期归档；和 AI 讨论时，可在输入框下方选择本次引用的材料。</p>
              {dialog.type !== "paper" && (
                <>
                  <h4>文献</h4>
                  {state.papers
                    .filter((p) => !p.deletedAt)
                    .map((p) => (
                      <label key={p.id}>
                        <input
                          type="checkbox"
                          disabled={linking}
                          checked={linked(
                            state,
                            dialog.type,
                            dialog.id,
                            "paper",
                            p.id,
                          )}
                          onChange={(e) =>
                            void saveAssociation(
                              dialog.type,
                              dialog.id,
                              "paper",
                              p.id,
                              e.target.checked,
                            )
                          }
                        />
                        {p.title}
                      </label>
                    ))}
                </>
              )}
              {dialog.type !== "topic" && (
                <>
                  <h4>研究问题</h4>
                  {state.topics.map((t) => (
                    <label key={t.id}>
                      <input
                        type="checkbox"
                          disabled={linking}
                        checked={linked(
                          state,
                          dialog.type,
                          dialog.id,
                          "topic",
                          t.id,
                        )}
                        onChange={(e) =>
                          void saveAssociation(
                            dialog.type,
                            dialog.id,
                            "topic",
                            t.id,
                            e.target.checked,
                          )
                        }
                      />
                      {t.title}
                    </label>
                  ))}
                </>
              )}
              {dialog.type !== "note" && (
                <>
                  <h4>已有想法</h4>
                  {ideas.map((n) => (
                    <label key={n.id}>
                      <input
                        type="checkbox"
                          disabled={linking}
                        checked={linked(
                          state,
                          "note",
                          n.id,
                          dialog.type,
                          dialog.id,
                        )}
                        onChange={(e) =>
                          void saveAssociation(
                            "note",
                            n.id,
                            dialog.type,
                            dialog.id,
                            e.target.checked,
                          )
                        }
                      />
                      {n.title}
                    </label>
                  ))}
                </>
              )}
              <div className={styles.associationFooter}><button type="button" disabled={linking} onClick={closeDialog}>完成</button></div>
            </div>
          )}
          {dialog.kind === "cite" && (
            <div className={styles.citationPicker}>
              <p>来源包含稳定链接。选择后插入当前光标位置。</p>
              <h4>文献与批注</h4>
              {state.papers
                .filter((p) => !p.deletedAt)
                .map((p) => (
                  <details key={p.id} open={paper?.id === p.id}>
                    <summary>{p.title}</summary>
                    <button
                      onClick={() => {
                        editor.current?.insert(
                          `\n[${p.title}](kb://paper/${p.id})\n`,
                        );
                        setDialog(null);
                      }}
                    >
                      引用文献
                    </button>
                    {state.annotations
                      .filter((a) => a.paperId === p.id)
                      .map((a) => (
                        <button
                          key={a.id}
                          onClick={() => {
                            editor.current?.insert(citeAnnotation(a, state));
                            setDialog(null);
                          }}
                        >
                          第 {a.pageIndex + 1} 页 ·{" "}
                          {(a.selectedText || a.comment || "页内区域").slice(
                            0,
                            90,
                          )}
                        </button>
                      ))}
                  </details>
                ))}
            </div>
          )}
          {dialog.kind === "insert" && (
            <div className={styles.citationPicker}>
              <p>{dialog.noteId ? "确认后追加到下列综合笔记，不覆盖已有内容。" : "选择目标笔记。引用保留原文快照与可返回的来源链接。"}</p>
              {dialog.noteId && <details><summary>预览写入内容</summary><pre className={styles.insertPreview}>{dialog.text}</pre></details>}
              {state.notes
                .filter((n) => dialog.noteId ? n.id === dialog.noteId : n.purpose !== "idea" || n.body || n.title)
                .map((n) => (
                  <button
                    key={n.id}
                    disabled={busy}
                    onClick={() => dialog.noteId ? void c.appendInto(n.id, dialog.text) : void insertInto(n.id, dialog.text)}
                  >
                    <span className={styles.typeBadge}>
                      {
                        { paper: "论文笔记", topic: "综合笔记", idea: "想法" }[
                          n.purpose
                        ]
                      }
                    </span>
                    {dialog.noteId ? `确认追加到「${n.title}」` : n.title}
                  </button>
                ))}
            </div>
          )}
        </DialogFrame>
      )}
    </>
  );
}
function DialogFrame({
  title,
  onClose,
  children,
  closeDisabled = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  closeDisabled?: boolean;
}) {
  const modal = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Capture before child autoFocus runs during commit, while the opener still owns focus.
  const returnFocus = useRef<HTMLElement | null>(
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null),
  );
  useEffect(() => {
    const previous = returnFocus.current;
    const initial = Array.from(modal.current?.querySelectorAll<HTMLElement>(
      'input:not([type="hidden"]):not([hidden]):not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])',
    ) ?? []).find((element) => element.getClientRects().length > 0);
    if (!modal.current?.contains(document.activeElement)) initial?.focus();
    const handle = (event: KeyboardEvent) => {
      // Nested controls may consume Escape (for example the tag dropdown).
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !event.isComposing
      ) {
        event.preventDefault();
        close.current();
      }
      if (event.key !== "Tab") return;
      const fields = Array.from(
        modal.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]',
        ) || [],
      ).filter((element) => element.getClientRects().length > 0);
      if (!fields.length) return;
      const first = fields[0];
      const last = fields[fields.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !modal.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      document.removeEventListener("keydown", handle);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className={styles.modalBackdrop}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={modal}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button
            aria-label="关闭弹窗"
            onClick={onClose}
            disabled={closeDisabled}
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Empty({
  title,
  text,
  action,
  onAction,
}: {
  title: string;
  text: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyIcon}>
        <Lightbulb size={28} />
      </div>
      <h2>{title}</h2>
      <p>{text}</p>
      {action && onAction && <button className={styles.primary} onClick={onAction}>
        {action}
      </button>}
    </div>
  );
}
