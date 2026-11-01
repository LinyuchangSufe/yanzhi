import assert from "node:assert/strict";
import test from "node:test";
import { isWorkspaceLink, storedWorkspaceLocation, workspaceHref, workspaceLocation, type WorkspaceLocation } from "../src/lib/workspace-navigation";

test("workspace URLs restore home sections and the active paper tab", () => {
  const locations: WorkspaceLocation[] = [
    { view: { kind: "home" }, section: "all", tab: "notes" },
    { view: { kind: "home" }, section: "settings", tab: "notes" },
    { view: { kind: "home" }, section: "ideas", tab: "notes" },
    { view: { kind: "paper", id: "paper-123" }, section: "unread", tab: "chat" },
    { view: { kind: "paper", id: "paper-123" }, section: "all", tab: "annotations" },
    { view: { kind: "topic", id: "topic-123" }, section: "topics", tab: "notes" },
    { view: { kind: "note", id: "note-123" }, section: "ideas", tab: "notes" },
  ];
  for (const location of locations) {
    const href = workspaceHref(location);
    assert.deepEqual(workspaceLocation(new URL(href, "http://localhost").search), location);
    assert.equal(workspaceHref(workspaceLocation(new URL(href, "http://localhost").search)), href);
  }
});

test("unknown URL values cannot become arbitrary views or identifiers", () => {
  assert.deepEqual(workspaceLocation("?view=admin&id=x&section=remote&tab=unknown"), {
    view: { kind: "home" }, section: "all", tab: "notes",
  });
  assert.deepEqual(workspaceLocation("?view=paper&id=../../secrets"), {
    view: { kind: "home" }, section: "all", tab: "notes",
  });
  assert.equal(workspaceHref(workspaceLocation("?view=paper&id=")), "/");
});

test("legacy stable-ID deep links stay supported without accepting arbitrary hashes", () => {
  for (const type of ["paper", "annotation", "note", "topic", "ai"]) {
    assert.equal(isWorkspaceLink(`#${type}/abc-123`), true);
  }
  for (const hash of ["#paper/../settings", "#paper/<script>", "#unknown/abc", "#paper/", "javascript:alert(1)"]) {
    assert.equal(isWorkspaceLink(hash), false);
  }
});

test("history return locations are validated and copied from browser-owned data", () => {
  const source = { view: { kind: "paper", id: "paper-123" }, section: "all", tab: "chat", scrollTop: 25 };
  assert.deepEqual(storedWorkspaceLocation(source), {
    view: { kind: "paper", id: "paper-123" }, section: "all", tab: "chat",
  });
  for (const entry of [null, "settings", {}, { ...source, section: "unknown" }, { ...source, tab: "unknown" }, { ...source, view: { kind: "paper", id: "../../x" } }]) {
    assert.equal(storedWorkspaceLocation(entry), null);
  }
});
