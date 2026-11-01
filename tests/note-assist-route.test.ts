import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { GET, POST } from "../src/app/api/kb/note-assist/route";
import { getStore } from "../src/lib/db";
import type { Note, Topic } from "../src/lib/types";

async function fixture(
  run: (f: {
    note: Note;
    other: Note;
    calls: string[];
    dir: string;
  }) => Promise<void>,
) {
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  const dir = mkdtempSync(path.join(os.tmpdir(), "kb-note-assist-route-"));
  process.env.KB_DATA_DIR = dir;
  process.env.KB_AI_PROVIDER = "ollama";
  process.env.KB_OLLAMA_URL = "http://127.0.0.1:11434";
  process.env.KB_OLLAMA_MODEL = "synthetic-fixture";
  const store = getStore();
  const topic = store.dispatch("topic.create", {
    title: "TEST · Current question",
  }) as Topic;
  const otherTopic = store.dispatch("topic.create", {
    title: "TEST · Unselected question",
  }) as Topic;
  let note = store.snapshot().notes.find((n) => n.id === topic.noteId)!;
  note = store.dispatch("note.update", {
    id: note.id,
    revision: note.revision,
    body: "SELECTED_TEST_PHRASE\n\nPRIVATE_UNSELECTED_PARAGRAPH",
  }) as Note;
  const other = store.snapshot().notes.find((n) => n.id === otherTopic.noteId)!;
  store.dispatch("note.update", {
    id: other.id,
    revision: other.revision,
    body: "OTHER_NOTE_DO_NOT_SEND",
  });
  const calls: string[] = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(String(options?.body));
    return Response.json({
      message: {
        content: JSON.stringify({
          overview: "Synthetic route fixture; no model was run.",
          edits: [],
          suggestions: [
            {
              title: "待验证的软件测试建议",
              body: "先明确本次软件验收的输入范围。",
              basis: "hypothesis",
              evidenceIds: [],
            },
          ],
        }),
      },
    });
  };
  try {
    await run({ note, other, calls, dir });
  } finally {
    globalThis.fetch = previousFetch;
    store.close();
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3118/api/kb/note-assist", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("note assistance GET is passive and scopes suggestions, history and context to the requested note", async () => {
  await fixture(async ({ note, other, calls }) => {
    const res = await GET(
      new Request(`http://127.0.0.1:3118/api/kb/note-assist?noteId=${note.id}`),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const body = await res.json();
    assert.deepEqual(body.assists, []);
    assert.deepEqual(body.revisions, []);
    assert.deepEqual(body.context.papers, []);
    assert.deepEqual(body.context.ideas, []);
    assert.doesNotMatch(
      JSON.stringify(body),
      new RegExp(other.id + "|OTHER_NOTE_DO_NOT_SEND"),
    );
    assert.equal(calls.length, 0);
    const invalid = await GET(
      new Request("http://localhost/api/kb/note-assist?noteId=invalid"),
    );
    assert.equal(invalid.status, 400);
  });
});

test("note assistance POST stores a separate suggestion and original snapshot without changing human Markdown", async () => {
  await fixture(async ({ note, calls, dir }) => {
    const store = getStore();
    const before = store.snapshot().notes;
    const mirror = readFileSync(
      path.join(dir, "notes", `${note.id}.md`),
      "utf8",
    );
    const res = await POST(
      request({
        noteId: note.id,
        revision: note.revision,
        mode: "advise",
        paperIds: [],
        ideaIds: [],
      }),
    );
    assert.equal(res.status, 200, await res.clone().text());
    const { result } = await res.json();
    assert.equal(result.noteId, note.id);
    assert.equal(result.mode, "advise");
    assert.equal(result.baseBody, note.body);
    assert.deepEqual(store.snapshot().notes, before);
    assert.equal(
      readFileSync(path.join(dir, "notes", `${note.id}.md`), "utf8"),
      mirror,
    );
    assert.equal(store.snapshot().noteAssists?.length, 1);
    assert.equal(store.snapshot().noteRevisions?.[0]?.body, note.body);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0], /OTHER_NOTE_DO_NOT_SEND/);
  });
});

test("selected-text requests send the selected paragraph without its unselected sibling or another note", async () => {
  await fixture(async ({ note, calls }) => {
    const text = "SELECTED_TEST_PHRASE";
    const res = await POST(
      request({
        noteId: note.id,
        revision: note.revision,
        mode: "advise",
        selection: { from: 0, to: text.length, text },
        paperIds: [],
        ideaIds: [],
      }),
    );
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(calls.length, 1);
    assert.match(calls[0], /SELECTED_TEST_PHRASE/);
    assert.doesNotMatch(
      calls[0],
      /PRIVATE_UNSELECTED_PARAGRAPH|OTHER_NOTE_DO_NOT_SEND/,
    );
  });
});

test("invalid, cross-site and non-JSON note assistance requests never reach a model", async () => {
  await fixture(async ({ note, calls }) => {
    const valid = {
      noteId: note.id,
      revision: note.revision,
      mode: "advise",
      paperIds: [],
      ideaIds: [],
    };
    for (const body of [
      { ...valid, prompt: "Not an accepted API field" },
      { ...valid, mode: "execute" },
      { ...valid, revision: -1 },
    ]) {
      const res = await POST(request(body));
      assert.equal(res.status, 400);
    }
    for (const headers of [
      { Origin: "https://untrusted.example" },
      { "Sec-Fetch-Site": "cross-site" },
      { Host: "untrusted.example" },
    ] as Array<Record<string, string>>) {
      assert.equal((await POST(request(valid, headers))).status, 403);
    }
    assert.equal(
      (await POST(request(valid, { "Content-Type": "text/plain" }))).status,
      415,
    );
    assert.equal(calls.length, 0);
  });
});

test("stale original revisions are rejected before AI execution and history creation", async () => {
  await fixture(async ({ note, calls }) => {
    const store = getStore();
    const newer = store.dispatch("note.update", {
      id: note.id,
      revision: note.revision,
      body: note.body + "\nNEW USER TYPING",
    }) as Note;
    const res = await POST(
      request({
        noteId: note.id,
        revision: note.revision,
        mode: "advise",
        paperIds: [],
        ideaIds: [],
      }),
    );
    assert.equal(res.status, 409);
    assert.equal(calls.length, 0);
    assert.equal(
      store.snapshot().notes.find((n) => n.id === note.id)?.body,
      newer.body,
    );
    assert.deepEqual(store.snapshot().noteRevisions, []);
  });
});
