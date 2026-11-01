// Opt-in real Codex acceptance. All content is original, explicitly synthetic.
// node --import tsx scripts/note-assist-smoke.mjs seed
// Serve the reported dataDir on 127.0.0.1:3118, then generate [polish|structure|advise].
// Browser apply/restore is tested separately; verify checks exports and a fresh restore.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KBStore } from "../src/lib/db.ts";
import { restoreBackup } from "../src/lib/archive.ts";

const cwd = fileURLToPath(new URL("..", import.meta.url));
process.chdir(cwd);
const reportPath = path.join(cwd, "test-results/note-assist-smoke.json");
const base = "http://127.0.0.1:3118";
const command = process.argv[2];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const topicBody =
  "## TEST：研究问题草稿\n\n这是原创软件测试材料，不是真实论文或研究成果。\n\n我想看看有时间依赖的数据中 SGD 应该研究什么，但目前目标还不清楚。\n\n我暂时只考虑标量递推 $x_{t+1}=a x_t+u_t$，噪声和参数条件尚未确定。\n\n我需要把研究对象、评价目标、假设条件和待验证的猜想分开。";
const ideaBody =
  "## TEST：一个尚未验证的想法\n\n这是原创软件测试材料。我我有一个想法，但是还没有说明白。\n\n可以先考虑 $a=0$，检查 $x_{t+1}=u_t$ 这个简单情形。结论尚未验证。\n\n下一步是先把目标和假设分开说清楚。";

function safeDirectory(directory) {
  const resolved = path.resolve(directory);
  assert.match(resolved, /^\/private\/tmp\/kb-note-assist-[A-Za-z0-9._-]+$/);
  assert.equal(fs.realpathSync(resolved), resolved);
  assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false);
  return resolved;
}
function writeReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  if (fs.existsSync(reportPath)) {
    const previous = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    if (previous.dataDir === report.dataDir) {
      const calls = new Map(
        previous.calls.map((call) => [
          `${call.mode}:${call.startedAtUTC}`,
          call,
        ]),
      );
      for (const call of report.calls) {
        const key = `${call.mode}:${call.startedAtUTC}`;
        if (call.result || !calls.get(key)?.result) calls.set(key, call);
      }
      report.calls = [...calls.values()].sort((a, b) =>
        a.startedAtUTC.localeCompare(b.startedAtUTC),
      );
    }
  }
  const temporary = `${reportPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n");
  fs.renameSync(temporary, reportPath);
}
if (command === "seed") {
  const directory = safeDirectory(
    fs.mkdtempSync("/private/tmp/kb-note-assist-browser-"),
  );
  const store = new KBStore(directory);
  try {
    store.dispatch("settings.update", {
      aiProvider: "codex",
      codexModel: "gpt-6.1-sol",
    });
    const topic = store.dispatch("topic.create", {
      title: "TEST · 梳理研究问题",
      description:
        "合成界面验收：帮助区分研究对象、目标、假设和待验证设想。不是科研结论。",
    });
    let note = store.snapshot().notes.find((item) => item.id === topic.noteId);
    note = store.dispatch("note.update", {
      id: note.id,
      revision: note.revision,
      body: topicBody,
    });
    const idea = store.dispatch("note.create", {
      title: "TEST · 我的研究想法",
      purpose: "idea",
      body: ideaBody,
      topicIds: [topic.id],
    });
    const paper = store.dispatch("paper.create", {
      title: "TEST · Synthetic scalar dependence note",
      authors: ["Software Acceptance Fixture"],
      year: 2026,
      abstract:
        "Original synthetic test material, not a scientific publication. The fixture specifies the scalar recurrence x_(t+1) = a*x_t + u_t but provides no theorem, experiment, numerical result or novelty claim. Its purpose is to check source attribution and research-question editing software.",
    });
    store.dispatch("link.set", {
      fromType: "paper",
      fromId: paper.id,
      toType: "topic",
      toId: topic.id,
    });
    const report = {
      createdAtUTC: new Date().toISOString(),
      base,
      dataDir: directory,
      baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      workingTreeDirty: true,
      fixturePolicy:
        "Original synthetic personal notes and synthetic abstract; no user content or real research conclusions.",
      configuration: {
        provider: "codex",
        model: "gpt-6.1-sol",
        port: 3118,
        modelSeed: null,
      },
      topicId: topic.id,
      topicNoteId: note.id,
      ideaId: idea.id,
      paperId: paper.id,
      originals: {
        topic: { title: note.title, body: topicBody, sha256: hash(topicBody) },
        idea: { title: idea.title, body: ideaBody, sha256: hash(ideaBody) },
      },
      calls: [],
      verification: null,
    };
    writeReport(report);
    console.log(
      JSON.stringify(
        {
          dataDir: directory,
          topicId: topic.id,
          topicNoteId: note.id,
          ideaId: idea.id,
          report: reportPath,
        },
        null,
        2,
      ),
    );
  } finally {
    store.close();
  }
} else {
  assert.ok(
    ["generate", "verify"].includes(command),
    "Choose seed, generate or verify",
  );
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  safeDirectory(report.dataDir);
  async function request(route, options) {
    const response = await fetch(base + route, {
      ...options,
      signal: AbortSignal.timeout(240000),
    });
    if (response.status !== 200)
      throw Object.assign(
        new Error(`HTTP ${response.status}: ${await response.text()}`),
        { status: response.status },
      );
    return response;
  }
  const json = async (route, options) => (await request(route, options)).json();
  const configuration = await json("/api/kb/ai");
  assert.equal(
    path.resolve(configuration.dataDir),
    report.dataDir,
    "Refusing an unrelated running library",
  );
  if (command === "generate") {
    assert.equal(configuration.provider, "codex");
    const requested = process.argv[3]
      ? [process.argv[3]]
      : ["polish", "structure", "advise"];
    for (const mode of requested) {
      assert.ok(["polish", "structure", "advise"].includes(mode));
      if (
        report.calls.some(
          (call) => call.mode === mode && call.result === "passed",
        )
      )
        continue;
      const before = await json("/api/kb");
      const noteId = mode === "polish" ? report.ideaId : report.topicNoteId;
      const note = before.notes.find((item) => item.id === noteId);
      const original =
        mode === "polish" ? report.originals.idea : report.originals.topic;
      assert.equal(
        note.body,
        original.body,
        "Generation must start with the untouched synthetic original",
      );
      const started = Date.now();
      const call = {
        mode,
        noteId,
        startedAtUTC: new Date().toISOString(),
        realModelRequested: true,
        realModelExecuted: null,
      };
      report.calls.push(call);
      writeReport(report);
      console.log(`Starting real Codex ${mode} on synthetic content`);
      try {
        const { result } = await json("/api/kb/note-assist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            noteId,
            revision: note.revision,
            mode,
            paperIds: mode === "advise" ? [report.paperId] : [],
            ideaIds: mode === "advise" ? [report.ideaId] : [],
          }),
        });
        assert.equal(result.mode, mode);
        assert.equal(result.baseBody, original.body);
        if (mode === "polish")
          assert.ok(
            result.result.edits.length > 0,
            "The deliberate duplicate-word fixture needs an actual proposed edit",
          );
        if (mode === "advise") {
          assert.equal(result.result.edits.length, 0);
          assert.ok(result.result.suggestions.length > 0);
          assert.ok(
            result.sources.some((source) => source.kind === "paper-abstract"),
          );
          assert.ok(result.sources.some((source) => source.kind === "idea"));
        }
        const after = await json("/api/kb");
        assert.deepEqual(
          after.notes,
          before.notes,
          "Real model generation must not change personal notes",
        );
        assert.ok(
          after.noteRevisions.some(
            (snapshot) =>
              snapshot.noteId === noteId && snapshot.body === original.body,
          ),
        );
        Object.assign(call, {
          result: "passed",
          realModelExecuted: true,
          assistanceId: result.id,
          provider: result.provider,
          model: result.model,
          proposedEdits: result.result.edits.length,
          suggestions: result.result.suggestions.length,
          sources: result.sources.map((source) => ({
            id: source.id,
            kind: source.kind,
          })),
          personalNotesUnchanged: true,
          elapsedMs: Date.now() - started,
        });
        writeReport(report);
        console.log(JSON.stringify(call));
      } catch (error) {
        Object.assign(call, {
          result: "failed",
          realModelExecuted: error?.status === 409 ? false : null,
          error: error instanceof Error ? error.message : "Unknown error",
          elapsedMs: Date.now() - started,
        });
        writeReport(report);
        throw error;
      }
    }
  } else {
    assert.ok(
      ["polish", "structure", "advise"].every((mode) =>
        report.calls.some(
          (call) => call.mode === mode && call.result === "passed",
        ),
      ),
    );
    const state = await json("/api/kb");
    const idea = state.notes.find((note) => note.id === report.ideaId);
    const topic = state.notes.find((note) => note.id === report.topicNoteId);
    assert.equal(
      idea.body,
      report.originals.idea.body,
      "After browser restore the original idea must be back",
    );
    assert.equal(topic.body, report.originals.topic.body);
    assert.ok(
      state.noteRevisions.some(
        (item) => item.noteId === idea.id && item.reason === "before-apply",
      ),
    );
    assert.ok(
      state.noteRevisions.some(
        (item) =>
          item.noteId === idea.id &&
          item.reason === "before-restore" &&
          item.body !== idea.body,
      ),
    );
    const markdown = await (await request("/api/kb/export")).text();
    assert.ok(markdown.includes(report.originals.idea.body));
    assert.ok(markdown.includes("synthetic"));
    const archive = Buffer.from(
      await (await request("/api/kb/backup")).arrayBuffer(),
    );
    const restoreRoot = safeDirectory(
      fs.mkdtempSync("/private/tmp/kb-note-assist-restore-"),
    );
    const restoredReport = restoreBackup(archive, restoreRoot);
    const restored = new KBStore(restoredReport.restoredDirectory);
    try {
      assert.deepEqual(restored.snapshot(), state);
    } finally {
      restored.close();
    }
    assert.deepEqual(
      await json("/api/kb"),
      state,
      "Verification cannot alter the running synthetic library",
    );
    report.verification = {
      result: "passed",
      verifiedAtUTC: new Date().toISOString(),
      originalRestored: true,
      adoptedVersionRetained: true,
      separateSuggestions: state.noteAssists.length,
      snapshots: state.noteRevisions.length,
      markdownContainsOriginals: true,
      fullBackupRoundtrip: true,
      restoredDirectory: restoredReport.restoredDirectory,
      backupSha256: hash(archive),
    };
    writeReport(report);
    console.log(JSON.stringify(report.verification, null, 2));
  }
}
