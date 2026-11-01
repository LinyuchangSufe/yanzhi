"use client";
import { BookOpen, ChevronDown, ChevronUp, Keyboard, MessageSquare, PanelLeftClose, Plus, Settings2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceController } from "../Workspace";
import TooltipButton from "../TooltipButton";
import styles from "./WorkspaceNavigation.module.css";

export function WorkspaceNavigation({ c, onShortcuts }: { c: WorkspaceController; onShortcuts: () => void }) {
  const { readingLayout, view, section, state } = c;
  const [topicsOpen, setTopicsOpen] = useState(true);
  const [utilitiesOpen, setUtilitiesOpen] = useState(false);
  const utilities = useRef<HTMLDivElement>(null);
  const utilityTrigger = useRef<HTMLButtonElement>(null);
  const mobile = useRef<HTMLDialogElement>(null);
  const mobileOpen = readingLayout.isMobile && !readingLayout.sidebarHidden;
  useEffect(() => {
    if (mobileOpen && !mobile.current?.open) mobile.current?.showModal();
    else if (!mobileOpen && mobile.current?.open) mobile.current.close();
  }, [mobileOpen]);
  useEffect(() => {
    if (!utilitiesOpen) return;
    const outside = (event: PointerEvent) => {
      if (!utilities.current?.contains(event.target as Node)) setUtilitiesOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      setUtilitiesOpen(false);
      utilityTrigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [utilitiesOpen]);
  const go = async (action: () => unknown | Promise<unknown>) => {
    const result = await action();
    if (result === false) return;
    setUtilitiesOpen(false);
    readingLayout.closeMobileSidebar();
  };
  const showSettings = async () => {
    return c.chooseSection("settings");
  };
  const content = <>
    <header className={styles.brandRow}>
      <button className={styles.brand} aria-label="研知，返回全部文献" onClick={() => void go(() => c.chooseSection("all"))}>
        <BookOpen size={22} /><span>研知</span>
      </button>
      <TooltipButton className={styles.icon} aria-label={readingLayout.isMobile ? "关闭导航" : "收起左侧导航"}
        onClick={readingLayout.isMobile ? readingLayout.closeMobileSidebar : readingLayout.toggleSidebar}>
        {readingLayout.isMobile ? <X size={19} /> : <PanelLeftClose size={18} />}
      </TooltipButton>
    </header>
    <nav className={styles.primaryNav} aria-label="主导航">
      {c.navigation.map(({ id, label, icon: Icon, ...rest }) => {
        const active = (view.kind === "home" && section === id) || (id === "topics" && view.kind === "topic") || (id === "ideas" && view.kind === "note");
        return <button key={id} className={active ? styles.active : ""} aria-current={active ? "page" : undefined}
          onClick={() => void go(() => c.chooseSection(id))}>
          <Icon size={18} /><span>{label}</span>{"count" in rest && <small>{rest.count}</small>}
        </button>;
      })}
    </nav>
    <div className={styles.recentHeading}>
      <button aria-expanded={topicsOpen} aria-controls="research-recent-topics" onClick={() => setTopicsOpen((open) => !open)}>
        <span>最近研究问题</span><ChevronDown size={14} className={topicsOpen ? "" : styles.collapsedChevron} />
      </button>
      <TooltipButton className={styles.icon} aria-label="新建研究问题" onClick={() => {
        readingLayout.closeMobileSidebar(); c.setDialog({ kind: "topic" });
      }}><Plus size={17} /></TooltipButton>
    </div>
    <nav className={styles.recent} id="research-recent-topics" aria-label="最近研究问题" hidden={!topicsOpen}>
      {state.topics.map((topic) => <button key={topic.id} title={topic.title}
        className={view.kind === "topic" && view.id === topic.id ? styles.active : ""}
        onClick={() => void go(() => c.navigate({ kind: "topic", id: topic.id }))}>
        <span className={styles.dot} /><span>{topic.title}</span>
      </button>)}
      {!state.topics.length && <p>围绕一个问题组织材料与思考。</p>}
    </nav>
    <div className={styles.utilities} ref={utilities}>
      {utilitiesOpen && <div className={styles.utilityPanel} role="group" aria-label="设置与帮助">
        <button onClick={() => void go(showSettings)}><Settings2 size={17} />设置与数据</button>
        <button aria-current={view.kind === "discussion" || (view.kind === "home" && section === "discussions") ? "page" : undefined} onClick={() => void go(() => c.chooseSection("discussions"))}><MessageSquare size={17} /><span>Codex 讨论</span><small>{(state.externalDiscussions ?? []).length}</small></button>
        {c.toolNavigation.filter(({ id }) => String(id) !== "discussions").map(({ id, label, icon: Icon, ...rest }) => <button key={id}
          onClick={() => void go(() => c.chooseSection(id))}>
          <Icon size={17} /><span>{label}</span>{"count" in rest && <small>{rest.count}</small>}
        </button>)}
        <button onClick={() => { setUtilitiesOpen(false); readingLayout.closeMobileSidebar(); onShortcuts(); }}>
          <Keyboard size={17} />快捷键<span className={styles.keyHint}>⌘ / Ctrl</span>
        </button>
        {view.kind !== "paper" && !readingLayout.isMobile && <button onClick={() => {
          readingLayout.toggleTopbar(); setUtilitiesOpen(false); utilityTrigger.current?.focus();
        }}>{readingLayout.topbarHidden ? "展开全局工具栏" : "收起全局工具栏"}</button>}
      </div>}
      <button ref={utilityTrigger} className={styles.utilityTrigger} aria-expanded={utilitiesOpen}
        onClick={() => setUtilitiesOpen((open) => !open)}>
        <Settings2 size={18} /><span>设置与帮助</span>{utilitiesOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
      </button>
    </div>
  </>;
  if (readingLayout.isMobile) return <dialog ref={mobile} className={styles.drawer} aria-label="工作区导航"
    onCancel={readingLayout.closeMobileSidebar} onClose={readingLayout.closeMobileSidebar}
    onClick={(event) => { if (event.target === event.currentTarget) readingLayout.closeMobileSidebar(); }}>
    <div className={styles.drawerBody}>{content}</div>
  </dialog>;
  return <aside className={styles.sidebar} hidden={readingLayout.sidebarHidden} aria-label="工作区导航">{content}</aside>;
}
