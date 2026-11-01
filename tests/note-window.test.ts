import assert from "node:assert/strict";
import test from "node:test";
import { openNoteWindow } from "../src/lib/editor/note-window";

class FakeLink {
  constructor(public href: string) {}
}
class FakeElement {
  children: FakeElement[] = [];
  className = "";
  title = "";
  src = "";
  href = "";
  textContent = "";
  contentDocument = { documentElement: { dataset: {} as Record<string, string> } };
  append(child: FakeElement) { this.children.push(child); }
  replaceChildren(child: FakeElement) { this.children = [child]; }
}
class FakeWindow {
  closed = false;
  focused = 0;
  navigated = "";
  listeners = new Map<string, () => void>();
  document = {
    title: "",
    head: new FakeElement(),
    body: new FakeElement(),
    documentElement: { lang: "" },
    createElement: () => new FakeElement(),
    importNode: (node: FakeElement) => Object.assign(new FakeElement(), node),
  };
  location = { replace: (url: string) => { this.navigated = url; } };
  focus() { this.focused++; }
  close() { this.closed = true; this.listeners.get("pagehide")?.(); }
  addEventListener(type: string, callback: () => void) { this.listeners.set(type, callback); }
  get browserWindow() { return this as unknown as Window; }
}

const noteId = (number: number) => `00000000-0000-0000-0000-${String(number).padStart(12, "0")}`;

test("independent note launcher preserves activation, existing windows, and save failures", async (t) => {
  const originals = new Map(["window", "document", "HTMLLinkElement"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const events: string[] = [];
  const opened: FakeWindow[] = [];
  const handlers = new Map<string, (event: BeforeUnloadEvent) => void>();
  let blocked = false;
  let pipTarget: FakeWindow | null = null;
  let rejectPiP = false;
  const api = {
    get window() { return pipTarget?.closed ? null : pipTarget?.browserWindow ?? null; },
    async requestWindow() {
      events.push("request-pip");
      if (rejectPiP) throw new Error("NotAllowedError");
      pipTarget = new FakeWindow();
      opened.push(pipTarget);
      return pipTarget.browserWindow;
    },
  };
  const browser: {
    location: { origin: string };
    documentPictureInPicture?: typeof api;
    open: () => Window | null;
    addEventListener: (name: string, callback: (event: BeforeUnloadEvent) => void) => void;
    removeEventListener: (name: string, callback: (event: BeforeUnloadEvent) => void) => void;
  } = {
    location: { origin: "http://127.0.0.1:3000" },
    open() {
      events.push("open-popup");
      if (blocked) return null;
      const target = new FakeWindow();
      opened.push(target);
      return target.browserWindow;
    },
    addEventListener(name, callback) { handlers.set(name, callback); },
    removeEventListener(name, callback) { if (handlers.get(name) === callback) handlers.delete(name); },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    baseURI: "http://127.0.0.1:3000/",
    head: { querySelectorAll: () => [
      new FakeLink("http://127.0.0.1:3000/_next/app.css"),
      new FakeLink("https://external.example/app.css"),
      { textContent: ".host{}" },
    ] },
  } });
  Object.defineProperty(globalThis, "HTMLLinkElement", { configurable: true, value: FakeLink });
  t.after(() => {
    for (const target of opened) target.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  await t.test("invalid note IDs never open a surface or save", async () => {
    await assert.rejects(openNoteWindow("../note", async () => { throw new Error("unexpected save"); }), /标识无效/);
    assert.equal(opened.length, 0);
  });
  await t.test("unsupported PiP opens a popup before waiting for save and reuses it", async () => {
    let finish: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const start = events.length;
    const first = openNoteWindow(noteId(1), () => { events.push("save"); return waiting; });
    assert.deepEqual(events.slice(start), ["open-popup", "save"]);
    assert.equal(opened.at(-1)?.navigated, "");
    const repeated = openNoteWindow(noteId(1), async () => { throw new Error("must reuse pending"); });
    finish?.();
    assert.deepEqual(await Promise.all([first, repeated]), ["window", "window"]);
    const target = opened.at(-1)!;
    assert.equal(target.navigated, `http://127.0.0.1:3000/note-window?id=${noteId(1)}`);
    const count = opened.length;
    await openNoteWindow(noteId(1), async () => { throw new Error("must reuse existing"); });
    assert.equal(opened.length, count);
    assert.ok(target.focused >= 2);
    target.close();
  });
  await t.test("save failure closes only the newly reserved popup", async () => {
    await assert.rejects(openNoteWindow(noteId(2), async () => { throw new Error("revision conflict"); }), /revision conflict.*仍保留/);
    assert.equal(opened.at(-1)?.closed, true);
  });
  await t.test("popup interception reports the cause without running save", async () => {
    blocked = true;
    let saved = false;
    await assert.rejects(openNoteWindow(noteId(3), async () => { saved = true; }), /浏览器拦截/);
    assert.equal(saved, false);
    blocked = false;
  });
  await t.test("PiP reserves before save and embeds an independent same-origin editor", async () => {
    browser.documentPictureInPicture = api;
    const start = events.length;
    assert.equal(await openNoteWindow(noteId(4), async () => { events.push("save-pip"); }), "pip");
    assert.deepEqual(events.slice(start), ["request-pip", "save-pip"]);
    const target = opened.at(-1)!;
    const host = target.document.body.children[0];
    const frame = host.children[0];
    assert.equal(host.className, "kb-note-window-host");
    assert.equal(frame.className, "kb-note-window-frame");
    assert.equal(frame.title, "独立笔记编辑器");
    assert.equal(frame.src, `http://127.0.0.1:3000/note-window?id=${noteId(4)}`);
    assert.equal(target.document.head.children.length, 3, "base, same-origin CSS, and inline style only");
    assert.equal(target.document.head.children[1].href, "http://127.0.0.1:3000/_next/app.css");
    frame.contentDocument.documentElement.dataset.noteDirty = "true";
    let prevented = false;
    const leaveEvent = { preventDefault() { prevented = true; }, returnValue: "" } as unknown as BeforeUnloadEvent;
    handlers.get("beforeunload")?.(leaveEvent);
    assert.equal(prevented, true);
    const count = opened.length;
    await openNoteWindow(noteId(4), async () => { throw new Error("must reuse pip"); });
    assert.equal(opened.length, count);
    await assert.rejects(openNoteWindow(noteId(5), async () => {}), /其他笔记/);
    assert.equal(target.closed, false);
    await openNoteWindow(noteId(5), async () => {}, { ordinary: true });
    assert.equal(target.closed, false, "ordinary fallback must preserve the existing PiP editor");
    opened.at(-1)!.close();
    target.close();
    assert.equal(handlers.has("beforeunload"), false);
  });
  await t.test("pending PiP is reused and never replaced by another note", async () => {
    let finish: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const first = openNoteWindow(noteId(6), () => waiting);
    const repeated = openNoteWindow(noteId(6), async () => { throw new Error("must reuse"); });
    await assert.rejects(openNoteWindow(noteId(7), async () => {}), /其他笔记/);
    finish?.();
    assert.deepEqual(await Promise.all([first, repeated]), ["pip", "pip"]);
    opened.at(-1)!.close();
  });
  await t.test("PiP rejection leaves fallback for the next explicit user click", async () => {
    rejectPiP = true;
    let saved = false;
    const count = opened.length;
    await assert.rejects(openNoteWindow(noteId(8), async () => { saved = true; }), /再次点击“普通窗口”/);
    assert.equal(opened.length, count);
    assert.equal(saved, false);
    assert.equal(await openNoteWindow(noteId(8), async () => {}, { ordinary: true }), "window");
    opened.at(-1)!.close();
  });
});
