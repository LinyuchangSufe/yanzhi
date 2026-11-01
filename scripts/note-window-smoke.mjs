// Synthetic-only detached-note acceptance fixture. This script never contacts
// port 3000 or starts a service. Run prepare, start its printed server command,
// then seed and conflict; inspect supplies IDs for browser checks. verify checks
// that preview/navigation did not change the persisted checkpoint. The explicit
// verify --after-browser mode permits only the documented two browser edits.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
process.chdir(cwd);
const base = "http://127.0.0.1:3126";
const reportPath = path.join(cwd, "test-results/note-window-smoke.json");
const mode = process.argv[2];
const afterBrowser = process.argv.includes("--after-browser");
assert.ok(["prepare", "seed", "conflict", "inspect", "verify"].includes(mode),
  "Use prepare|seed|conflict|inspect|verify");
assert.ok(!afterBrowser || mode === "verify", "--after-browser is only valid with verify");

function safeDirectory(directory) {
  assert.equal(typeof directory, "string");
  assert.match(directory, /^\/private\/tmp\/kb-note-window-[A-Za-z0-9_-]+$/,
    "Refusing a non-test data directory");
  assert.equal(fs.realpathSync(directory), directory,
    "Refusing a symlink to another library");
  assert.equal(fs.lstatSync(directory).isDirectory(), true);
  return directory;
}

function save(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}

async function request(route, options = {}, status = 200) {
  assert.ok(route.startsWith("/api/kb") && !route.startsWith("//"));
  const response = await fetch(base + route, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: { Origin: base, ...options.headers },
  });
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
const post = (action, payload, status) => request("/api/kb", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action, payload }),
}, status);
const snapshot = () => request("/api/kb");
const noteById = (state, id) => {
  const note = state.notes.find((item) => item.id === id);
  assert.ok(note, `Missing fixture note ${id}`);
  return note;
};

function verifyMirrors(state, directory) {
  for (const note of state.notes) {
    assert.match(note.id, /^[A-Za-z0-9_-]+$/);
    const mirror = fs.readFileSync(path.join(directory, "notes", `${note.id}.md`), "utf8");
    assert.equal(mirror,
      `<!-- kb-note:${note.id} revision:${note.revision} purpose:${note.purpose} -->\n# ${note.title}\n\n${note.body}\n`,
      "Personal Markdown mirror must match the saved note exactly");
  }
}

if (mode === "prepare") {
  const dataDir = safeDirectory(fs.mkdtempSync("/private/tmp/kb-note-window-"));
  console.log(JSON.stringify({
    result: "prepared",
    base,
    dataDir,
    serverCommand: `KB_DATA_DIR='${dataDir}' KB_AI_PROVIDER=none PORT=3126 npm start`,
    nextCommands: [
      "node scripts/note-window-smoke.mjs seed",
      "node scripts/note-window-smoke.mjs conflict",
      "node scripts/note-window-smoke.mjs inspect",
      "node scripts/note-window-smoke.mjs verify",
    ],
    cleanup: "Stop the isolated service, then remove only the reported temporary directory.",
  }, null, 2));
} else {
  // Every mutation below is gated by configuration read from the fixed test port.
  const configuration = await request("/api/kb/ai");
  assert.equal(configuration.provider, "none", "AI calls must be disabled");
  const dataDir = safeDirectory(configuration.dataDir);
  const state = await snapshot();

  if (mode === "seed") {
    for (const [key, value] of Object.entries(state))
      if (Array.isArray(value))
        assert.equal(value.length, 0, `Refusing a nonempty fixture library: ${key}`);
    const paperResponse = await post("paper.create", {
      title: "TEST · 浮窗研究文献",
      authors: ["Synthetic Fixture Author"],
      year: 2026,
      abstract: "原创软件验收素材，不是真实学术文献或研究结论。",
    });
    const paper = paperResponse.result;
    const paperNote = paperResponse.state.notes.find((note) => note.purpose === "paper");
    assert.ok(paperNote);
    await post("note.update", {
      id: paperNote.id,
      revision: paperNote.revision,
      body: "## TEST · 论文笔记\n\n论文笔记保持默认编辑。浮窗写作期间可以在主界面查看资料。\n\n$y=x^2$",
    });
    const topic = (await post("topic.create", {
      title: "TEST · 浮窗研究问题",
      description: "测试默认预览与显式编辑。所有内容均为原创验收资料。",
    })).result;
    const topicNote = noteById(await snapshot(), topic.noteId);
    await post("note.update", {
      id: topicNote.id,
      revision: topicNote.revision,
      body: `## 问题定义\n\n独特短语：纸舟浮窗研究问题。\n\n阅读此信息时应保持预览。\n\n[参考文献](kb://paper/${paper.id})`,
    });
    const idea = (await post("note.create", {
      title: "TEST · 浮窗我的想法",
      purpose: "idea",
      paperIds: [paper.id],
      topicIds: [topic.id],
      body: `## 我的想法\n\n独特短语：纸舟浮窗独立写作。\n\n[已有研究问题](kb://topic/${topic.id})\n\n原有公式 $\\alpha+\\beta$ 应保留。`,
    })).result;
    const emptyTopic = (await post("topic.create", { title: "TEST · 空白研究问题" })).result;
    const emptyIdea = (await post("note.create", {
      title: "TEST · 空白我的想法", purpose: "idea", body: "",
    })).result;
    const baseline = await snapshot();
    assert.equal(noteById(baseline, topic.noteId).purpose, "topic");
    assert.equal(noteById(baseline, paperNote.id).purpose, "paper");
    verifyMirrors(baseline, dataDir);
    const report = {
      createdAtUTC: new Date().toISOString(),
      base,
      dataDir,
      baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      workingTreeDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
      policy: "Fixed loopback port 3126; strict real /private/tmp/kb-note-window-* directory; AI disabled; synthetic data only; never contacts port 3000.",
      seed: null,
      paperId: paper.id,
      paperNoteId: paperNote.id,
      topicId: topic.id,
      topicNoteId: topic.noteId,
      ideaId: idea.id,
      emptyTopicId: emptyTopic.id,
      emptyTopicNoteId: emptyTopic.noteId,
      emptyIdeaId: emptyIdea.id,
      baseline,
      checkpoint: baseline,
      checks: [{ stage: "seed", result: "passed", verifiedAtUTC: new Date().toISOString() }],
    };
    save(report);
    console.log(JSON.stringify({ result: "seeded", base, dataDir, reportPath,
      paperId: paper.id, paperNoteId: paperNote.id, topicId: topic.id,
      topicNoteId: topic.noteId, ideaId: idea.id,
      emptyTopicId: emptyTopic.id, emptyIdeaId: emptyIdea.id }, null, 2));
  } else {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.base, base);
    assert.equal(report.dataDir, dataDir, "Fixture differs from the seeded test library");
    if (mode === "inspect") {
      console.log(JSON.stringify({ base, dataDir, reportPath,
        paperId: report.paperId, paperNoteId: report.paperNoteId,
        topicId: report.topicId, topicNoteId: report.topicNoteId,
        ideaId: report.ideaId, emptyTopicId: report.emptyTopicId,
        emptyIdeaId: report.emptyIdeaId, recoveryNoteId: report.recoveryNoteId,
        notes: state.notes, lastCheck: report.checks.at(-1) }, null, 2));
    } else if (mode === "conflict") {
      assert.equal(report.checks.some((check) => check.stage === "conflict"), false,
        "Conflict stage already passed; seed a new isolated library for another run");
      assert.deepEqual(state, report.checkpoint, "Run conflict before any browser editing");
      const before = noteById(state, report.ideaId);
      const serverBody = before.body + "\n\nTEST_SERVER_VERSION_FROM_OTHER_WINDOW";
      const localTitle = before.title + " · 本地恢复副本";
      const localBody = before.body + "\n\nTEST_LOCAL_UNSAVED_CONTENT_MUST_SURVIVE_409";
      const updated = (await post("note.update", {
        id: before.id, revision: before.revision, title: before.title, body: serverBody,
      })).result;
      assert.equal(updated.revision, before.revision + 1);
      const expected = await snapshot();
      const conflict = await post("note.update", {
        id: before.id, revision: before.revision, title: localTitle, body: localBody,
      }, 409);
      assert.equal(typeof conflict.error, "string");
      const afterConflict = await snapshot();
      assert.deepEqual(afterConflict, expected, "A stale revision must not mutate any server record");
      assert.equal(noteById(afterConflict, before.id).body, serverBody);
      const recovery = (await post("note.create", {
        title: localTitle, body: localBody, purpose: "idea",
      })).result;
      assert.notEqual(recovery.id, before.id);
      assert.equal(recovery.title, localTitle);
      assert.equal(recovery.body, localBody);
      const afterRecovery = await snapshot();
      assert.equal(noteById(afterRecovery, before.id).body, serverBody,
        "Saving a recovery copy must preserve the other window's server version");
      assert.equal(noteById(afterRecovery, recovery.id).body, localBody);
      assert.deepEqual(afterRecovery.notes.filter((note) => note.id !== recovery.id),
        expected.notes, "Recovery must not alter existing notes");
      verifyMirrors(afterRecovery, dataDir);
      report.recoveryNoteId = recovery.id;
      report.checkpoint = afterRecovery;
      const check = { stage: "conflict", result: "passed", verifiedAtUTC: new Date().toISOString(),
        scopes: ["stale note.update returns 409 without changing server state",
          "note.create recovery retains local title/body and original server content",
          "saved Markdown mirrors match server records"],
        limit: "API/data integrity only; popup, picture-in-picture and preview controls require separate browser checks." };
      report.checks.push(check);
      save(report);
      console.log(JSON.stringify({ ...check, recoveryNoteId: recovery.id }, null, 2));
    } else {
      if (afterBrowser) {
        const before = noteById(report.checkpoint, report.ideaId);
        const after = noteById(state, report.ideaId);
        const beforeTime = Date.parse(before.updatedAt);
        const afterTime = Date.parse(after.updatedAt);
        assert.ok(Number.isFinite(beforeTime) && Number.isFinite(afterTime),
          "The checkpoint and browser save must contain valid timestamps");
        assert.equal(new Date(afterTime).toISOString(), after.updatedAt,
          "The browser save timestamp must retain the stored ISO format");
        assert.ok(afterTime > beforeTime && afterTime <= Date.now(),
          "The browser save timestamp must advance without being in the future");
        const expected = structuredClone(report.checkpoint);
        const target = noteById(expected, report.ideaId);
        target.body += "\nTEST_PIP_TYPED_WHILE_MAIN_BROWSING\nTEST_SAVE_AND_CLOSE_WITHOUT_WAIT";
        target.revision += 2;
        target.updatedAt = after.updatedAt;
        const editedReference = (relation) => relation.fromType === "note" &&
          relation.fromId === report.ideaId && relation.purpose === "reference";
        const referencesBefore = expected.relations.filter(editedReference);
        const referencesAfter = state.relations.filter(editedReference);
        const semanticReference = ({ id, createdAt, ...reference }) => reference;
        const referenceSet = (references) => references.map((relation) =>
          JSON.stringify(semanticReference(relation))).sort();
        assert.deepEqual(referenceSet(referencesAfter), referenceSet(referencesBefore),
          "The edited idea must retain exactly the same source-link targets and purposes");
        for (const relation of referencesAfter) {
          const original = referencesBefore.find((item) =>
            JSON.stringify(semanticReference(item)) === JSON.stringify(semanticReference(relation)));
          assert.ok(original);
          if (relation.id === original.id) assert.deepEqual(relation, original);
          else {
            assert.match(relation.id,
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            const indexedAt = Date.parse(relation.createdAt);
            assert.ok(Number.isFinite(indexedAt) && indexedAt > Date.parse(original.createdAt) && indexedAt <= Date.now(),
              "A recreated reference-index entry must have a valid advanced timestamp");
          }
        }
        assert.equal(new Set(state.relations.map((relation) => relation.id)).size,
          state.relations.length, "Reference regeneration must not introduce duplicate relation IDs");
        assert.deepEqual({ ...state, relations: state.relations.filter((relation) => !editedReference(relation)) },
          { ...expected, relations: expected.relations.filter((relation) => !editedReference(relation)) },
          "Browser acceptance may only append the two exact markers to the idea in two saved revisions; all other fields and records must remain unchanged");
        const screenshots = [
          "docs/screenshots/note-window/pip-editor.png",
          "docs/screenshots/note-window/main-with-pip.png",
        ];
        for (const screenshot of screenshots)
          assert.ok(fs.existsSync(path.join(cwd, screenshot)), `Missing browser evidence: ${screenshot}`);
        report.browserObservations = {
          observer: "root agent",
          source: "Native Chrome browser acceptance reported by root; this script independently checks persisted API state and Markdown mirrors.",
          recordedAtUTC: new Date().toISOString(),
          steps: [
            "Main-window idea opened in preview; popout opened a native always-on-top picture-in-picture editor.",
            "An empty research question also opened in preview, and explicitly clicking Edit set aria-pressed=true; a paper note retained its default edit mode.",
            "The first exact marker was appended in picture-in-picture and autosaved while browsing the main window.",
            "The existing research-question link in picture-in-picture preview opened the topic preview in the main window while picture-in-picture stayed open.",
            "The second exact marker was appended and Save and Close was clicked immediately; the main-window idea preview displayed both markers without reload.",
            "Chrome displayed and accepted input in the real picture-in-picture iframe; source navigation and window close succeeded under the application's CSP.",
          ],
          screenshots,
          referenceIndexBehavior: "Existing KBStore.syncReferences deletes and rebuilds reference-index entries on note.update, changing their IDs, createdAt values and array positions. This verifier permits those metadata changes only for the edited idea's reference entries, validates regenerated IDs/timestamps, and requires the source-link semantic set to remain exact; all other relations remain byte-for-byte equal.",
          limit: "The script verifies only the reported two-save data contract; native window behavior was exercised by root in Chrome.",
        };
      } else {
        assert.deepEqual(state, report.checkpoint,
          "Previewing and navigating must not change persisted library content");
      }
      verifyMirrors(state, dataDir);
      const check = { stage: afterBrowser ? "verify-after-browser" : "verify", result: "passed", verifiedAtUTC: new Date().toISOString(),
        scope: afterBrowser
          ? "The idea contains only the two exact marker appends, revision +2 and an advanced timestamp; its existing reference-index metadata may regenerate while link targets remain exact. Every other record and relation is unchanged, and all Markdown mirrors match."
          : "All persisted records and personal Markdown mirrors match the checkpoint." };
      report.checks.push(check);
      save(report);
      console.log(JSON.stringify(check, null, 2));
    }
  }
}
