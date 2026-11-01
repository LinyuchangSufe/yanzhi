import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { GET, POST } from "../src/app/api/kb/research-items/route";
import { getStore } from "../src/lib/db";
import type { Topic } from "../src/lib/types";

test("research-item route enforces local origin, strict inputs, real snapshots and revisions without touching AI or notes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-research-items-route-")), previous = process.env.KB_DATA_DIR;
  process.env.KB_DATA_DIR = root;
  const store = getStore();
  const request = (body: unknown, extra: Record<string, string> = {}) => {
    const headers = new Headers({ "Content-Type": "application/json" }); for (const [key, value] of Object.entries(extra)) headers.set(key, value);
    return new Request("http://127.0.0.1:3000/api/kb/research-items", { method: "POST", headers, body: JSON.stringify(body) });
  };
  try {
    const topic = store.dispatch("topic.create", { title: "TEST · route核验" }) as Topic;
    const note = store.snapshot().notes.find(item => item.id === topic.noteId)!;
    const before = store.snapshot(), payload = { action: "create", id: randomUUID(), topicId: topic.id, title: "手动核验问题" };
    assert.equal((await POST(request(payload, { origin: "https://foreign.example" }))).status, 403);
    assert.equal((await GET(new Request("http://foreign.example/api/kb/research-items"))).status, 403);
    assert.equal((await POST(request({ ...payload, status: "resolved" }))).status, 400, "creation cannot accept a resolved flag");
    assert.equal((await POST(request({ ...payload, sourceRefs: [{ kind: "note", id: note.id, revision: note.revision, text: "伪造来源文本" }] }))).status, 400);
    assert.equal((await POST(request(payload, { "content-type": "text/plain" }))).status, 415);
    assert.equal((await POST(request(payload, { "content-length": "100001" }))).status, 413);
    const saved = await POST(request(payload)); assert.equal(saved.status, 200);
    const value = await saved.json(); assert.equal(value.item.status, "pending");
    const updated = await POST(request({ action: "update", id: value.item.id, revision: 1, nextAction: "回看合成输入" })); assert.equal(updated.status, 200);
    assert.equal((await POST(request({ action: "update", id: value.item.id, revision: 1, title: "过期输入" }))).status, 409);
    assert.equal((await POST(request({ action: "update", id: value.item.id, revision: 2, status: "resolved", resolution: "没有结果来源" }))).status, 400);
    const listed = await GET(new Request(`http://127.0.0.1:3000/api/kb/research-items?topicId=${topic.id}`)); assert.equal(listed.status, 200);
    assert.equal((await listed.json()).items.length, 1);
    assert.equal((await POST(request({ action: "archive", id: value.item.id, revision: 2 }))).status, 200);
    assert.equal((await (await GET(new Request(`http://127.0.0.1:3000/api/kb/research-items?topicId=${topic.id}`))).json()).items.length, 0);
    const archived = await (await GET(new Request(`http://127.0.0.1:3000/api/kb/research-items?topicId=${topic.id}&archived=true`))).json(); assert.equal(archived.items.length, 1);
    assert.equal((await POST(request({ action: "restore", id: value.item.id, revision: archived.items[0].revision }))).status, 200);
    const after = store.snapshot(); assert.deepEqual(after.notes, before.notes); assert.deepEqual(after.aiContents, before.aiContents); assert.deepEqual(after.settings, before.settings);
  } finally { store.close(); if (previous === undefined) delete process.env.KB_DATA_DIR; else process.env.KB_DATA_DIR = previous; rmSync(root, { recursive: true, force: true }); }
});
