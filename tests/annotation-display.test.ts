import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KBStore } from "../src/lib/db";
import { commentedAnnotations } from "../src/lib/annotation-display";
import type { Annotation, Paper } from "../src/lib/types";

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kb-annotation-display-"));
  const store = new KBStore(dir);
  const paper = store.dispatch("paper.create", { title: "TEST · Plain highlight visibility" }) as Paper;
  const attachment = store.addAttachment(paper.id, "fixture.pdf", Buffer.from("%PDF-1.7\nSynthetic highlight fixture\n%%EOF"));
  const create = (comment: string, kind: Annotation["kind"] = "highlight") => store.dispatch("annotation.create", {
    paperId: paper.id,
    attachmentId: attachment.id,
    kind,
    pageIndex: 0,
    pageLabel: "1",
    rects: [{ x: 0.1, y: 0.5, width: 0.5, height: 0.02 }],
    selectedText: kind === "highlight" ? "This original excerpt stays saved." : "",
    comment,
  }) as Annotation;
  return { store, paper, create, cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("plain highlights and whitespace comments stay saved without filling the comments sidebar", () => {
  const ctx = fixture();
  try {
    const plain = ctx.create("");
    const whitespace = ctx.create(" \n\t ");
    const commented = ctx.create("My observation about this passage");
    const region = ctx.create("Equation needs verification", "region");
    ctx.create("", "region");
    const snapshot = ctx.store.snapshot();
    assert.equal(snapshot.annotations.length, 5);
    assert.deepEqual(commentedAnnotations(snapshot.annotations, ctx.paper.id).map((mark) => mark.id), [commented.id, region.id]);
    assert.deepEqual(commentedAnnotations(snapshot.annotations, "another-paper"), []);
    assert.deepEqual(snapshot.annotations.find((mark) => mark.id === plain.id), plain);
    assert.deepEqual(snapshot.annotations.find((mark) => mark.id === whitespace.id), whitespace);
  } finally { ctx.cleanup(); }
});

test("adding and removing the last comment changes sidebar visibility without removing PDF highlight geometry", () => {
  const ctx = fixture();
  try {
    const plain = ctx.create("");
    assert.equal(commentedAnnotations(ctx.store.snapshot().annotations, ctx.paper.id).length, 0);
    const commented = ctx.store.dispatch("annotation.update", {
      id: plain.id, revision: plain.revision, comment: "Now this mark also has a comment.",
    }) as Annotation;
    assert.deepEqual(commentedAnnotations(ctx.store.snapshot().annotations, ctx.paper.id), [commented]);
    const restored = ctx.store.dispatch("annotation.update", {
      id: commented.id, revision: commented.revision, comment: " \n ",
    }) as Annotation;
    const snapshot = ctx.store.snapshot();
    assert.equal(commentedAnnotations(snapshot.annotations, ctx.paper.id).length, 0);
    assert.deepEqual(snapshot.annotations, [restored]);
    assert.equal(restored.selectedText, plain.selectedText);
    assert.deepEqual(restored.rects, plain.rects);
    assert.equal(restored.attachmentId, plain.attachmentId);
    assert.equal(restored.pageIndex, plain.pageIndex);
  } finally { ctx.cleanup(); }
});
