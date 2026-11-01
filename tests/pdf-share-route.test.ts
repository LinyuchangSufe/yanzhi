import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { POST } from "../src/app/api/kb/pdf-share/route";
import { getStore } from "../src/lib/db";
import type { Paper } from "../src/lib/types";

function request(body: unknown = {}, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3125/api/kb/pdf-share", {
    method: "POST", headers: { Origin: "http://127.0.0.1:3125", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
async function fixture(run: (paper: Paper, directory: string) => Promise<void>) {
  const previous = process.env.KB_DATA_DIR;
  const directory = mkdtempSync(path.join(os.tmpdir(), "kb-pdf-share-route-"));
  process.env.KB_DATA_DIR = directory;
  const store = getStore();
  const paper = store.dispatch("paper.create", { title: "TEST Route PDF sharing" }) as Paper;
  store.addAttachment(paper.id, "garbled.pdf", Buffer.from("%PDF-1.7\nTEST route sharing\n%%EOF"));
  try { await run(paper, directory); }
  finally {
    store.close();
    if (previous === undefined) delete process.env.KB_DATA_DIR;
    else process.env.KB_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("same-origin JSON sharing defaults to no OS opening and does not change library snapshots", async () => {
  await fixture(async (paper) => {
    const before = getStore().snapshot();
    const response = await POST(request({ paperId: paper.id }));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const result = await response.json();
    assert.equal(result.opened, false);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].paperId, paper.id);
    assert.equal(readdirSync(result.directory).length, 1);
    assert.deepEqual(getStore().snapshot(), before);
    assert.equal((await POST(request())).status, 200);
  });
});

test("cross-site, absent-origin, bad host, non-JSON and unknown path/command fields cannot invoke sharing", async () => {
  await fixture(async (paper, directory) => {
    for (const headers of [
      { Origin: "https://evil.example" },
      { Origin: "null" },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
      { Host: "evil.example" },
    ] as Array<Record<string, string>>) assert.equal((await POST(request({ paperId: paper.id }, headers))).status, 403);
    assert.equal((await POST(new Request("http://127.0.0.1:3125/api/kb/pdf-share", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))).status, 403);
    for (const contentType of ["text/plain", "application/jsonx", "multipart/form-data"])
      assert.equal((await POST(request({}, { "Content-Type": contentType }))).status, 415);
    for (const body of [
      { paperId: "invalid" }, { open: "true" }, { open: 1 },
      { directory: "/tmp/evil", open: true }, { command: "touch /tmp/evil" },
      { paperId: paper.id, path: "../../secret.pdf" },
    ]) assert.equal((await POST(request(body))).status, 400);
    assert.equal(readdirSync(directory).includes("share"), false);
  });
});

test("same-origin fetch metadata is accepted and JSON request size remains bounded", async () => {
  await fixture(async () => {
    const response = await POST(new Request("http://127.0.0.1:3125/api/kb/pdf-share", { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", "Sec-Fetch-Site": "same-origin" }, body: "{}" }));
    assert.equal(response.status, 200);
    assert.equal((await POST(request({}, { "Content-Length": "5000" }))).status, 413);
    const invalidJSON = new Request("http://127.0.0.1:3125/api/kb/pdf-share", { method: "POST", headers: { Origin: "http://127.0.0.1:3125", "Content-Type": "application/json" }, body: "{" });
    assert.equal((await POST(invalidJSON)).status, 400);
  });
});

test("Next's internal localhost URL accepts the browser's validated 127.0.0.1 Host and Origin", async () => {
  await fixture(async (paper) => {
    const response = await POST(new Request("http://localhost:3125/api/kb/pdf-share", {
      method: "POST",
      headers: {
        Host: "127.0.0.1:3125",
        Origin: "http://127.0.0.1:3125",
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ paperId: paper.id }),
    }));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).files.length, 1);
  });
});

test("unexpected local I/O failures explain share preparation without claiming unsaved user input", async () => {
  await fixture(async (paper) => {
    const store = getStore();
    const originalSnapshot = store.snapshot;
    try {
      store.snapshot = () => { throw new Error("synthetic local I/O failure"); };
      const response = await POST(request({ paperId: paper.id }));
      assert.equal(response.status, 500);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const result = await response.json();
      assert.match(result.error, /无法整理 PDF 分享副本/);
      assert.match(result.error, /原件未被修改/);
      assert.doesNotMatch(result.error, /输入尚未保存|synthetic local/);
    } finally { store.snapshot = originalSnapshot; }
  });
});
