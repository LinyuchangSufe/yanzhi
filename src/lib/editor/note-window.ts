type NoteWindowMode = "pip" | "window";
interface PictureInPictureAPI {
  window: Window | null;
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}
interface OpenNoteWindow {
  mode: NoteWindowMode;
  window: Window;
}

const openWindows = new Map<string, OpenNoteWindow>();
const openingWindows = new Map<string, Promise<NoteWindowMode>>();
let openingPictureInPicture = false;

function pictureInPictureAPI(): PictureInPictureAPI | undefined {
  return (
    window as Window & { documentPictureInPicture?: PictureInPictureAPI }
  ).documentPictureInPicture;
}

function copyStyles(target: Document) {
  const base = target.createElement("base");
  base.href = `${window.location.origin}/`;
  target.head.append(base);
  for (const source of document.head.querySelectorAll(
    'link[rel="stylesheet"], style',
  )) {
    if (source instanceof HTMLLinkElement) {
      const url = new URL(source.href, document.baseURI);
      if (url.origin !== window.location.origin) continue;
      const link = target.importNode(source, true);
      link.href = url.href;
      target.head.append(link);
    } else {
      target.head.append(target.importNode(source, true));
    }
  }
}

function mountPictureInPicture(target: Window, url: string, noteId: string) {
  const targetDocument = target.document;
  targetDocument.title = "独立笔记";
  targetDocument.documentElement.lang = "zh-CN";
  copyStyles(targetDocument);
  const host = targetDocument.createElement("div");
  host.className = "kb-note-window-host";
  const frame = targetDocument.createElement("iframe");
  frame.className = "kb-note-window-frame";
  frame.title = "独立笔记编辑器";
  frame.src = url;
  host.append(frame);
  targetDocument.body.replaceChildren(host);

  // A PiP window is destroyed with its opener. Its independent editor writes
  // this marker synchronously, so closing the main tab also warns about drafts.
  const guard = (event: BeforeUnloadEvent) => {
    try {
      const flags = frame.contentDocument?.documentElement.dataset;
      if (flags?.noteDirty !== "true" && flags?.noteBusy !== "true")
        return;
      event.preventDefault();
      event.returnValue = "";
    } catch {
      // The iframe is same-origin; an unavailable document has no editable UI.
    }
  };
  window.addEventListener("beforeunload", guard);
  target.addEventListener(
    "pagehide",
    () => {
      window.removeEventListener("beforeunload", guard);
      if (openWindows.get(noteId)?.window === target)
        openWindows.delete(noteId);
    },
    { once: true },
  );
}

async function launchWindow(
  noteId: string,
  prepare: () => Promise<void>,
  api: PictureInPictureAPI | undefined,
): Promise<NoteWindowMode> {
  let target: Window | null = null;
  let prepared = false;
  const mode: NoteWindowMode = api ? "pip" : "window";
  try {
    // Reserve the browser surface before yielding: both APIs need user activation.
    if (api) {
      openingPictureInPicture = true;
      try {
        target = await api.requestWindow({ width: 760, height: 760 });
      } catch {
        throw new Error(
          "浏览器未能打开画中画。请再次点击“普通窗口”打开独立编辑器。当前编辑内容仍保留。",
        );
      }
    } else {
      target = window.open(
        "about:blank",
        "_blank",
        "popup=yes,width=760,height=760,resizable=yes,scrollbars=yes",
      );
      if (!target)
        throw new Error(
          "独立窗口被浏览器拦截。请允许此站点弹出窗口后，再点击“普通窗口”。当前编辑内容仍保留。",
        );
    }
    target.document.title = "正在准备独立笔记…";
    target.document.body.textContent = "正在保存当前内容…";
    try {
      await prepare();
      prepared = true;
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : "保存失败"}。未打开独立编辑器，当前编辑内容仍保留。`,
      );
    }
    if (target.closed)
      throw new Error("独立窗口已关闭。笔记已保存，可再次打开。");
    const url = new URL("/note-window", window.location.origin);
    url.searchParams.set("id", noteId);
    if (api) mountPictureInPicture(target, url.href, noteId);
    else target.location.replace(url.href);
    openWindows.set(noteId, { mode, window: target });
    target.focus();
    return mode;
  } catch (error) {
    target?.close();
    if (error instanceof Error) throw error;
    throw new Error(
      prepared
        ? "笔记已保存，但独立窗口打开失败，请重试。"
        : "独立窗口打开失败。当前编辑内容仍保留，请重试。",
    );
  } finally {
    if (api) openingPictureInPicture = false;
  }
}

/** Call directly from a click handler, before awaiting any save or other work. */
export async function openNoteWindow(
  noteId: string,
  prepare: () => Promise<void>,
  options: { ordinary?: boolean } = {},
): Promise<NoteWindowMode> {
  if (typeof window === "undefined")
    throw new Error("独立笔记窗口只能在浏览器中打开。");
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(noteId))
    throw new Error("笔记标识无效，未打开独立窗口。");
  const opening = openingWindows.get(noteId);
  if (opening) {
    const mode = await opening;
    openWindows.get(noteId)?.window.focus();
    return mode;
  }
  const existing = openWindows.get(noteId);
  if (existing && !existing.window.closed) {
    existing.window.focus();
    return existing.mode;
  }
  openWindows.delete(noteId);
  const api = options.ordinary ? undefined : pictureInPictureAPI();
  if (api && (openingPictureInPicture || api.window))
    throw new Error(
      "已有其他笔记正在画中画中编辑。请先保存并关闭它，或点击“普通窗口”打开这篇笔记。",
    );
  const task = launchWindow(noteId, prepare, api);
  openingWindows.set(noteId, task);
  try {
    return await task;
  } finally {
    if (openingWindows.get(noteId) === task) openingWindows.delete(noteId);
  }
}
