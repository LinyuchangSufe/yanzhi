import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkCodex, codexEnvironment, runCodex } from "../src/lib/ai/codex";
import { testCodexConnection } from "../src/lib/ai/codex-check";
import { POST as checkConnection } from "../src/app/api/kb/ai/check/route";
import { aiConfiguration, generateAI } from "../src/lib/ai";
import { getStore, KBStore, StoreError } from "../src/lib/db";
import type { Paper } from "../src/lib/types";
import { snapshotSchema } from "../src/lib/validation";

const summary = {
  researchProblem: "Fixture research problem, not a model result",
  coreMethod: "A fake executable verifies the CLI transport contract",
  mainContributions: "No scientific claims are made by this test fixture",
};

interface Invocation {
  args: string[];
  pid: number;
  cwd: string;
  input: string;
  schema?: unknown;
  secret?: string;
  codexKey?: string;
  unrelated?: string;
}

interface Fixture {
  root: string;
  setMode(mode: string): void;
  calls(): Invocation[];
}

/** A real child process at the system boundary; it never calls a model or reads credentials. */
async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-codex-boundary-"));
  const executable = path.join(root, "fixture codex.mjs");
  const modeFile = path.join(root, "mode.json");
  const logFile = path.join(root, "calls.jsonl");
  const descendantFile = path.join(root, "descendant.pid");
  const descendantScript = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(descendantFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const previous = { ...process.env };
  const script = `#!${process.execPath}
import fs from 'node:fs';
import {spawn} from 'node:child_process';
const args = process.argv.slice(2);
const mode = JSON.parse(fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8'));
if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.142.4-fixture\\n');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  const authenticated = mode !== 'unauthenticated';
  process.stderr.write(authenticated ? 'Logged in using ChatGPT\\n' : 'Not logged in\\n');
  process.exit(authenticated ? 0 : 1);
}
if (args[0] !== 'exec') process.exit(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const schemaIndex = args.indexOf('--output-schema');
const schema = schemaIndex < 0 ? undefined : JSON.parse(fs.readFileSync(args[schemaIndex + 1], 'utf8'));
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({args,pid:process.pid,cwd:process.cwd(),input,schema,
  secret:process.env.KB_OPENAI_API_KEY,codexKey:process.env.CODEX_API_KEY,unrelated:process.env.KB_TEST_UNRELATED_SECRET}) + '\\n');
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (mode === 'timeout') {
  setInterval(() => {}, 1000);
} else if (mode === 'wrapper-timeout') {
  spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], {stdio:['ignore','inherit','inherit']});
  setInterval(() => {}, 1000);
} else if (mode === 'quota') {
  process.stderr.write('Usage limit exceeded: fixture-private-diagnostic');
  process.exit(1);
} else if (mode === 'auth-error') {
  process.stderr.write('Authentication failed: fixture-private-diagnostic');
  process.exit(1);
} else if (mode === 'malformed') {
  process.stdout.write('this is not a JSONL event\\n');
} else if (mode === 'empty') {
  emit({type:'turn.completed'});
} else if (mode === 'tool') {
  emit({type:'item.completed',item:{type:'command_execution',command:'must not execute',exit_code:0}});
  emit({type:'item.completed',item:{type:'agent_message',text:'MUST NOT SAVE TOOL OUTPUT'}});
  emit({type:'turn.completed'});
} else if (mode === 'no-completion') {
  emit({type:'item.completed',item:{type:'agent_message',text:'MUST NOT SAVE INCOMPLETE TURN'}});
} else if (mode === 'event-quota') {
  emit({type:'turn.failed',error:{message:'usage_limit_reached fixture-private-diagnostic'}});
} else if (mode === 'oversize') {
  process.stdout.write('x'.repeat(2 * 1024 * 1024));
} else if (mode === 'probe-ok' || mode === 'probe-mismatch') {
  emit({type:'item.completed',item:{type:'agent_message',text:mode === 'probe-ok' ? 'KB_CODEX_OK' : 'fixture-private-diagnostic: unexpected probe output'}});
  emit({type:'turn.completed'});
} else if (mode === 'model-error') {
  process.stderr.write('Model fixture-secret-model not supported: fixture-private-diagnostic');
  process.exit(1);
} else if (mode === 'connection') {
  process.stderr.write('Connection refused: fixture-private-diagnostic');
  process.exit(1);
} else if (mode === 'invalid-summary') {
  emit({type:'item.completed',item:{type:'agent_message',text:'{ "researchProblem": "incomplete" }'}});
  emit({type:'turn.completed'});
} else if (mode === 'partial-error') {
  emit({type:'item.completed',item:{type:'agent_message',text:'MUST NOT SAVE PARTIAL OUTPUT'}});
  process.stderr.write('fixture-private-diagnostic');
  process.exitCode = 1;
} else {
  emit({type:'thread.started',thread_id:'fixture-thread'});
  emit({type:'item.completed',item:{type:'reasoning',text:'Internal fixture event is not final output'}});
  emit({type:'item.completed',item:{type:'agent_message',text:mode === 'summary' ? JSON.stringify(${JSON.stringify(summary)}) : 'Fixture explanation: material does not establish a theorem.'}});
  emit({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
}
`;
  writeFileSync(executable, script);
  chmodSync(executable, 0o700);
  writeFileSync(modeFile, JSON.stringify("explanation"));
  process.env.KB_CODEX_BIN = executable;
  // Child-process startup can exceed 2s under the parallel full suite.
  // Deadline/cancellation cases below still set their own short limits.
  process.env.KB_CODEX_TIMEOUT_MS = "8000";
  process.env.KB_OPENAI_API_KEY = "fixture-other-provider-secret";
  process.env.KB_TEST_UNRELATED_SECRET = "fixture-unrelated-secret";
  delete process.env.CODEX_API_KEY;
  try {
    await run({
      root,
      setMode(mode) { writeFileSync(modeFile, JSON.stringify(mode)); },
      calls() {
        if (!existsSync(logFile)) return [];
        return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Invocation);
      },
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(root, { recursive: true, force: true });
  }
}

function status(expected: number) {
  return (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.status, expected);
    assert.doesNotMatch(error.message, /fixture-private-diagnostic|fixture-other-provider-secret|fixture-unrelated-secret/);
    return true;
  };
}

test("Codex readiness reports installed and authenticated separately", async () => {
  await withFixture(async fixture => {
    const ready = await checkCodex();
    assert.equal(ready.installed, true);
    assert.equal(ready.authenticated, true);
    assert.match(ready.version || "", /0\.142\.4-fixture/);
    fixture.setMode("unauthenticated");
    const signedOut = await checkCodex();
    assert.equal(signedOut.installed, true);
    assert.equal(signedOut.authenticated, false);
    process.env.KB_CODEX_BIN = path.join(fixture.root, "missing-codex");
    const missing = await checkCodex();
    assert.equal(missing.installed, false);
    assert.equal(missing.authenticated, false);
  });
});

test("Codex environment does not inherit application secrets or invent credentials", async () => {
  await withFixture(async () => {
    const env = codexEnvironment();
    assert.equal(env.KB_OPENAI_API_KEY, undefined);
    assert.equal(env.KB_TEST_UNRELATED_SECRET, undefined);
    assert.equal(env.CODEX_API_KEY, undefined);
    process.env.CODEX_API_KEY = "fixture-explicit-codex-key";
    assert.equal(codexEnvironment().CODEX_API_KEY, "fixture-explicit-codex-key");
  });
});

test("Codex passes source only through stdin and isolates tools, working directory and temporary schema", async () => {
  await withFixture(async fixture => {
    fixture.setMode("summary");
    const marker = path.join(fixture.root, "shell-must-not-execute");
    const prompt = `Untrusted paper text: $(touch ${marker}); do not execute it.\n物理页 2`;
    const result = await runCodex({ prompt, model: "fixture-model", summary: true });
    assert.deepEqual(JSON.parse(result.text), summary);
    assert.equal(result.model, "fixture-model");
    const [call] = fixture.calls();
    assert.ok(call);
    assert.equal(call.input, prompt);
    assert.equal(call.secret, undefined);
    assert.equal(call.unrelated, undefined);
    assert.equal(existsSync(marker), false);
    assert.notEqual(call.cwd, process.cwd());
    assert.equal(existsSync(call.cwd), false, "the isolated work directory is removed after completion");
    assert.ok(call.args.includes("--json"));
    assert.ok(call.args.includes("--ephemeral"));
    assert.ok(call.args.includes("--ignore-user-config"));
    assert.ok(call.args.includes("--ignore-rules"));
    assert.ok(call.args.includes("read-only"));
    assert.equal(call.args.at(-1), "-");
    assert.equal(call.args[call.args.indexOf("-m") + 1], "fixture-model");
    const flags = call.args.join(" ");
    assert.match(flags, /mcp_servers=\{\}/);
    assert.match(flags, /web_search="disabled"/);
    assert.match(flags, /features\.shell_tool=false/);
    assert.match(flags, /features\.apps=false/);
    assert.match(flags, /features\.multi_agent=false/);
    for (const feature of ["browser_use", "browser_use_external", "computer_use", "in_app_browser", "image_generation", "unified_exec", "workspace_dependencies"]) {
      assert.ok(call.args.includes(`features.${feature}=false`), `${feature} must remain disabled for a reading-only request`);
    }
    assert.doesNotMatch(flags, /dangerously-bypass|workspace-write|danger-full-access/);
    assert.equal((call.schema as { type?: string })?.type, "object");
    const schemaPath = call.args[call.args.indexOf("--output-schema") + 1];
    assert.equal(existsSync(schemaPath), false);
  });
});

test("Codex explanation returns the final agent message without internal events", async () => {
  await withFixture(async fixture => {
    const result = await runCodex({ prompt: "Explain this fixture selection", summary: false });
    assert.match(result.text, /^Fixture explanation:/);
    assert.doesNotMatch(result.text, /Internal fixture event|thread.started/);
    assert.ok(result.model);
    assert.equal(fixture.calls()[0].args.includes("--output-schema"), false);
  });
});

test("quick translation lowers reasoning only for that invocation and never changes the configured model", async () => {
  await withFixture(async fixture => {
    process.env.KB_DATA_DIR = path.join(fixture.root, "quick-library");
    process.env.KB_AI_PROVIDER = "codex";
    process.env.KB_CODEX_MODEL = "explicit-quick-model";
    process.env.CODEX_HOME = path.join(fixture.root, "fixture-codex-home");
    const store = getStore();
    try {
      const paper = store.dispatch("paper.create", { title: "QUICK TASK FIXTURE", abstract: "Known context for an explicit transport fixture." }) as Paper;
      const settings = store.snapshot().settings;
      const input = { paperId: paper.id, kind: "translation" as const, selection: "transport boundary" };
      const first = await generateAI(input);
      assert.equal(first.model, "explicit-quick-model");
      assert.equal((await generateAI(input)).id, first.id);
      assert.equal(fixture.calls().length, 1);
      assert.ok(fixture.calls()[0].args.includes('model_reasoning_effort="low"'));
      await generateAI({ ...input, kind: "explanation" });
      assert.equal(fixture.calls()[1].args.some((value) => value.startsWith("model_reasoning_effort=")), false);
      assert.deepEqual(store.snapshot().settings, settings);
      process.env.KB_CODEX_MODEL = "";
      const defaultModel = { ...input, selection: "implicit default model fixture" };
      await generateAI(defaultModel); await generateAI(defaultModel);
      assert.equal(fixture.calls().length, 4, "implicit CLI defaults are not attributed to an old cached model");
    } finally { store.close(); }
  });
});

test("Codex rejects failed, malformed, empty and oversized results without exposing diagnostics", async () => {
  await withFixture(async fixture => {
    for (const [mode, expected] of [["quota", 429], ["event-quota", 429], ["auth-error", 422], ["malformed", 502], ["empty", 502], ["no-completion", 502], ["tool", 502], ["oversize", 502], ["partial-error", 502]] as const) {
      fixture.setMode(mode);
      await assert.rejects(runCodex({ prompt: "Boundary fixture", summary: false }), status(expected));
    }
    process.env.KB_CODEX_BIN = path.join(fixture.root, "missing-codex");
    await assert.rejects(runCodex({ prompt: "Missing binary fixture", summary: false }), status(422));
  });
});

test("Codex timeout and cancellation stop the child and remove its temporary directory", async () => {
  await withFixture(async fixture => {
    fixture.setMode("timeout");
    process.env.KB_CODEX_TIMEOUT_MS = "100";
    await assert.rejects(runCodex({ prompt: "Timeout fixture", summary: false }), status(502));
    for (const call of fixture.calls()) {
      assert.equal(existsSync(call.cwd), false);
      assert.throws(() => process.kill(call.pid, 0), { code: "ESRCH" });
    }
    process.env.KB_CODEX_TIMEOUT_MS = "2000";
    const controller = new AbortController();
    const pending = runCodex({ prompt: "Cancel fixture", summary: false, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 100);
    try { await assert.rejects(pending, status(499)); }
    finally { clearTimeout(timer); }
    for (const call of fixture.calls()) {
      assert.equal(existsSync(call.cwd), false);
      assert.throws(() => process.kill(call.pid, 0), { code: "ESRCH" });
    }
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(runCodex({ prompt: "Already cancelled", summary: false, signal: alreadyAborted.signal }), status(499));
  });
});

test("Codex permits one active generation and releases the lock after cancellation", async () => {
  await withFixture(async fixture => {
    fixture.setMode("timeout");
    const controller = new AbortController();
    const pending = runCodex({ prompt: "First request", summary: false, signal: controller.signal });
    await assert.rejects(runCodex({ prompt: "Competing request", summary: false }), status(409));
    controller.abort();
    await assert.rejects(pending, status(499));
    fixture.setMode("explanation");
    assert.match((await runCodex({ prompt: "New request after cancellation", summary: false })).text, /^Fixture explanation:/);
  });
});

test("Codex timeout kills a wrapper and its TERM-ignoring descendant with inherited pipes", { skip: process.platform === "win32" }, async () => {
  await withFixture(async fixture => {
    fixture.setMode("wrapper-timeout");
    process.env.KB_CODEX_TIMEOUT_MS = "2000";
    const descendantFile = path.join(fixture.root, "descendant.pid");
    let watchdogUsed = false;
    const watchdog = setTimeout(() => {
      // Bound the regression test even if process-group termination is accidentally removed.
      watchdogUsed = true;
      if (existsSync(descendantFile)) {
        try { process.kill(Number(readFileSync(descendantFile, "utf8")), "SIGKILL"); } catch { /* Already exited. */ }
      }
      for (const call of fixture.calls()) {
        try { process.kill(call.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    }, 6500);
    try {
      await assert.rejects(runCodex({ prompt: "Wrapper timeout fixture", summary: false }), status(502));
      assert.equal(watchdogUsed, false, "termination must not wait for the test watchdog");
      assert.equal(existsSync(descendantFile), true, "the TERM-ignoring child must have actually started");
      const descendant = Number(readFileSync(descendantFile, "utf8"));
      // A killed orphan may briefly remain visible until the OS reaps it.
      let descendantGone = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(descendant, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { descendantGone = true; break; } throw error; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(descendantGone, true, "the descendant must be terminated, not left running after wrapper exit");
      const [wrapper] = fixture.calls();
      assert.throws(() => process.kill(wrapper.pid, 0), { code: "ESRCH" });
      assert.equal(existsSync(wrapper.cwd), false);
      fixture.setMode("explanation");
      process.env.KB_CODEX_TIMEOUT_MS = "2000";
      assert.match((await runCodex({ prompt: "Request after wrapper timeout", summary: false })).text, /^Fixture explanation:/);
    } finally {
      clearTimeout(watchdog);
      if (existsSync(descendantFile)) {
        try { process.kill(Number(readFileSync(descendantFile, "utf8")), "SIGKILL"); } catch { /* Already terminated. */ }
      }
    }
  });
});

test("Codex generation preserves human notes and existing AI records on every failed attempt", async () => {
  await withFixture(async fixture => {
    process.env.KB_DATA_DIR = path.join(fixture.root, "library");
    process.env.KB_AI_PROVIDER = "codex";
    const store = getStore();
    try {
      assert.equal(aiConfiguration().configured, true);
      const paper = store.dispatch("paper.create", { title: "Codex transport fixture", abstract: "TEST SOURCE ONLY: the fixture describes no theorem or experimental result." }) as Paper;
      const snapshot = store.snapshot();
      const note = snapshot.notes.find(n => snapshot.relations.some(r => r.fromId === n.id && r.toId === paper.id))!;
      assert.ok(note);
      store.dispatch("note.update", { id: note.id, revision: note.revision, body: "个人笔记必须完整保留，不能作为未授权上下文发送。" });
      const notesBefore = store.snapshot().notes;
      const mirror = path.join(store.dataDir, "notes", `${note.id}.md`);
      const mirrorBefore = readFileSync(mirror, "utf8");
      fixture.setMode("summary");
      const result = await generateAI({ paperId: paper.id, kind: "summary" });
      assert.equal(result.provider, "codex");
      assert.equal(result.sourceScope, "abstract");
      assert.equal(result.sourceAttachmentId, null);
      assert.deepEqual(result.sourcePageIndices, []);
      assert.equal(result.sourceText, paper.abstract);
      assert.match(result.body, /Fixture research problem/);
      assert.doesNotMatch(fixture.calls().at(-1)?.input || "", /个人笔记必须完整保留/);
      assert.deepEqual(store.snapshot().notes, notesBefore);
      assert.equal(readFileSync(mirror, "utf8"), mirrorBefore);
      const existingAI = store.snapshot().aiContents;
      for (const mode of ["invalid-summary", "partial-error", "quota", "malformed"]) {
        fixture.setMode(mode);
        await assert.rejects(generateAI({ paperId: paper.id, kind: "summary" }));
        assert.deepEqual(store.snapshot().aiContents, existingAI, `${mode} must not append or replace AI content`);
        assert.deepEqual(store.snapshot().notes, notesBefore);
        assert.equal(readFileSync(mirror, "utf8"), mirrorBefore);
      }
      assert.ok(readdirSync(path.join(store.dataDir, "notes")).includes(`${note.id}.md`));
    } finally { store.close(); }
  });
});

test("unrelated settings patches preserve the saved Codex model across restart", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-codex-settings-"));
  let store = new KBStore(root);
  try {
    store.dispatch("settings.update", { aiProvider: "codex", codexModel: "fixture-saved-model" });
    store.dispatch("settings.update", { splitRatio: 0.72 });
    assert.equal(store.snapshot().settings.codexModel, "fixture-saved-model");
    store.dispatch("settings.update", { appearance: "system" });
    store.dispatch("settings.update", { ollamaModel: "fixture-other-provider-model" });
    store.dispatch("settings.update", {});
    store.close();
    store = new KBStore(root);
    const settings = store.snapshot().settings;
    assert.equal(settings.codexModel, "fixture-saved-model");
    assert.equal(settings.aiProvider, "codex");
    assert.equal(settings.splitRatio, 0.72);
    assert.equal(settings.appearance, "system");
    assert.equal(settings.ollamaModel, "fixture-other-provider-model");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("opening a legacy SQLite library adds Codex settings without changing papers or human notes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-codex-legacy-db-"));
  const legacy = new DatabaseSync(path.join(root, "knowledge.sqlite"));
  let store: KBStore | undefined;
  const paperId = "10000000-0000-4000-8000-000000000001";
  const noteId = "10000000-0000-4000-8000-000000000002";
  const createdAt = "2026-10-29T00:00:00.000Z";
  try {
    legacy.exec(readFileSync(path.resolve("migrations/001.sql"), "utf8"));
    assert.equal(legacy.prepare("PRAGMA table_info(settings)").all().some(column => column.name === "codex_model"), false);
    legacy.prepare("UPDATE settings SET ai_provider=?, ollama_model=?, split_ratio=? WHERE id=1").run("ollama", "fixture-legacy-model", 0.7);
    legacy.prepare("INSERT INTO papers (id,title,reading_status,revision,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(paperId, "原有文献", "reading", 3, createdAt, createdAt);
    legacy.prepare("INSERT INTO notes (id,title,body,purpose,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(noteId, "原有个人笔记", "历史笔记与修订号必须保留。", "paper", 7, createdAt, createdAt);
    legacy.close();
    store = new KBStore(root);
    const snapshot = store.snapshot();
    assert.equal(snapshot.settings.codexModel, "");
    assert.equal(snapshot.settings.aiProvider, "ollama");
    assert.equal(snapshot.settings.ollamaModel, "fixture-legacy-model");
    assert.equal(snapshot.settings.splitRatio, 0.7);
    assert.equal(snapshot.papers.find(paper => paper.id === paperId)?.revision, 3);
    assert.equal(snapshot.papers.find(paper => paper.id === paperId)?.readingStatus, "reading");
    assert.equal(snapshot.notes.find(note => note.id === noteId)?.body, "历史笔记与修订号必须保留。");
    assert.equal(snapshot.notes.find(note => note.id === noteId)?.revision, 7);
    assert.match(readFileSync(path.join(root, "notes", `${noteId}.md`), "utf8"), /历史笔记与修订号必须保留/);
    store.dispatch("settings.update", { codexModel: "fixture-new-model" });
    assert.equal(store.snapshot().settings.codexModel, "fixture-new-model");
    assert.equal(store.snapshot().notes.find(note => note.id === noteId)?.revision, 7);
  } finally {
    store?.close();
    if (!store) { try { legacy.close(); } catch { /* Already closed before a failed migration. */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy backups without codexModel validate and restore using the CLI default", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-codex-legacy-backup-"));
  const source = new KBStore(path.join(root, "source"));
  const target = new KBStore(path.join(root, "restored"));
  try {
    const paper = source.dispatch("paper.create", { title: "Legacy backup fixture" }) as Paper;
    const note = source.snapshot().notes[0];
    source.dispatch("note.update", { id: note.id, revision: note.revision, body: "备份中的个人推导" });
    source.dispatch("settings.update", { aiProvider: "ollama", ollamaModel: "fixture-backup-model", splitRatio: 0.68 });
    const snapshot = source.snapshot();
    const { codexModel: _codexModel, ...legacySettings } = snapshot.settings;
    const parsed = snapshotSchema.parse({ ...snapshot, settings: legacySettings });
    assert.equal(parsed.settings.codexModel, "");
    assert.equal(parsed.settings.ollamaModel, "fixture-backup-model");
    target.importSnapshot(parsed);
    const restored = target.snapshot();
    assert.equal(restored.settings.codexModel, "");
    assert.equal(restored.settings.aiProvider, "ollama");
    assert.equal(restored.settings.splitRatio, 0.68);
    assert.equal(restored.papers.find(item => item.id === paper.id)?.title, paper.title);
    assert.equal(restored.notes.find(item => item.id === note.id)?.body, "备份中的个人推导");
    assert.deepEqual(restored.relations, snapshot.relations);
  } finally {
    source.close(); target.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("Codex connection probe uses a fixed tiny prompt, the current model and the isolated transport", async () => {
  await withFixture(async fixture => {
    fixture.setMode("probe-ok");
    const result = await testCodexConnection({ model: "fixture-form-model" });
    assert.equal(result.service, "available");
    assert.equal(result.installed, true);
    assert.equal(result.authenticated, true);
    assert.equal(result.model, "fixture-form-model");
    assert.equal(Number.isFinite(Date.parse(result.checkedAt)), true);
    assert.ok(result.elapsedMs >= 0);
    assert.equal(result.errorStatus, undefined);
    const [call] = fixture.calls();
    assert.equal(fixture.calls().length, 1);
    assert.match(call.input, /KB_CODEX_OK/);
    assert.ok(call.input.length < 1000, "probe sends only a small fixed instruction");
    assert.equal(call.args[call.args.indexOf("-m") + 1], "fixture-form-model");
    assert.equal(call.args.includes("--output-schema"), false);
    assert.ok(call.args.includes("--ignore-user-config"));
    assert.ok(call.args.includes("--ignore-rules"));
    assert.ok(call.args.includes("read-only"));
    assert.ok(call.args.includes("features.shell_tool=false"));
    assert.ok(call.args.includes("mcp_servers={}"));
    assert.equal(call.args.at(-1), "-");
    assert.notEqual(call.cwd, process.cwd());
    assert.equal(existsSync(call.cwd), false);
    assert.equal(call.secret, undefined);
    assert.equal(call.unrelated, undefined);
    const firstPrompt = call.input;
    await testCodexConnection({ model: "fixture-other-model" });
    assert.equal(fixture.calls()[1].input, firstPrompt, "model selection cannot change the fixed probe prompt");
  });
});

test("Codex connection probe never runs a model when the CLI is missing or logged out", async () => {
  await withFixture(async fixture => {
    fixture.setMode("unauthenticated");
    const signedOut = await testCodexConnection({ model: "fixture-model" });
    assert.equal(signedOut.installed, true);
    assert.equal(signedOut.authenticated, false);
    assert.equal(signedOut.service, "not-tested");
    assert.equal(fixture.calls().length, 0);
    process.env.KB_CODEX_BIN = path.join(fixture.root, "missing-probe-cli");
    const missing = await testCodexConnection({});
    assert.equal(missing.installed, false);
    assert.equal(missing.authenticated, false);
    assert.equal(missing.service, "not-tested");
    assert.equal(fixture.calls().length, 0);
  });
});

test("Codex connection probe rejects a completed turn that does not return the expected sentinel", async () => {
  await withFixture(async fixture => {
    fixture.setMode("probe-mismatch");
    const result = await testCodexConnection({});
    assert.equal(result.service, "unavailable");
    assert.equal(result.errorStatus, 502);
    assert.doesNotMatch(JSON.stringify(result), /fixture-private-diagnostic|unexpected probe output/);
    assert.equal(fixture.calls().length, 1);
  });
});

test("Codex connection probe classifies quota, expired auth, unsupported models and transport failures without diagnostics", async () => {
  await withFixture(async fixture => {
    for (const [mode, expected] of [["quota", 429], ["auth-error", 422], ["model-error", 422], ["connection", 502], ["malformed", 502], ["empty", 502]] as const) {
      fixture.setMode(mode);
      const result = await testCodexConnection({ model: "fixture-selected-model" });
      assert.equal(result.service, "unavailable", mode);
      assert.equal(result.errorStatus, expected, mode);
      assert.doesNotMatch(JSON.stringify(result), /fixture-private-diagnostic|fixture-secret-model|fixture-other-provider-secret|fixture-unrelated-secret/);
    }
    fixture.setMode("timeout");
    process.env.KB_CODEX_TIMEOUT_MS = "100";
    const timedOut = await testCodexConnection({});
    assert.equal(timedOut.service, "unavailable");
    assert.equal(timedOut.errorStatus, 502);
    for (const call of fixture.calls()) assert.equal(existsSync(call.cwd), false);
  });
});

test("Codex connection probe shares the generation lock, respects cancellation and permits retry", async () => {
  await withFixture(async fixture => {
    fixture.setMode("timeout");
    const controller = new AbortController();
    const pending = testCodexConnection({ signal: controller.signal });
    const started = Date.now();
    while (fixture.calls().length === 0 && Date.now() - started < 5000)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fixture.calls().length, 1, "the first probe reached the fake model boundary");
    try {
      await assert.rejects(runCodex({ prompt: "Competing synthetic reading request", summary: false }), status(409));
      const busy = await testCodexConnection({});
      assert.equal(busy.service, "not-tested");
      assert.equal(busy.errorStatus, 409);
      assert.equal(fixture.calls().length, 1, "a busy probe must not start a second exec");
    } finally { controller.abort(); }
    await assert.rejects(pending, status(499));
    for (const call of fixture.calls()) {
      assert.equal(existsSync(call.cwd), false);
      assert.throws(() => process.kill(call.pid, 0), { code: "ESRCH" });
    }
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(testCodexConnection({ signal: alreadyAborted.signal }), status(499));
    fixture.setMode("probe-ok");
    assert.equal((await testCodexConnection({})).service, "available");
  });
});

function connectionRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3000/api/kb/ai/check", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("Codex probe HTTP route tests the draft model with environment precedence and never modifies library contents", async () => {
  await withFixture(async fixture => {
    process.env.KB_DATA_DIR = path.join(fixture.root, "probe-library");
    delete process.env.KB_CODEX_MODEL;
    const store = getStore();
    try {
      store.dispatch("settings.update", { aiProvider: "codex", codexModel: "fixture-saved-model" });
      const paper = store.dispatch("paper.create", {
        title: "Private paper must not enter a connection test",
        abstract: "PRIVATE_PAPER_ABSTRACT_DO_NOT_SEND",
      }) as Paper;
      const note = store.snapshot().notes.find(n => store.snapshot().relations.some(r => r.fromId === n.id && r.toId === paper.id))!;
      store.dispatch("note.update", { id: note.id, revision: note.revision, body: "PRIVATE_PERSONAL_NOTE_DO_NOT_SEND" });
      const before = store.snapshot();
      const mirror = path.join(store.dataDir, "notes", `${note.id}.md`);
      const beforeMirror = readFileSync(mirror, "utf8");
      fixture.setMode("probe-ok");
      const response = await checkConnection(connectionRequest({ provider: "codex", model: "fixture-draft-model" }));
      assert.equal(response.status, 200);
      const first = await response.json() as { codexStatus: { service: string; model: string } };
      assert.equal(first.codexStatus.service, "available");
      assert.equal(first.codexStatus.model, "fixture-draft-model");
      assert.equal(fixture.calls().at(-1)?.args[fixture.calls().at(-1)!.args.indexOf("-m") + 1], "fixture-draft-model");
      process.env.KB_CODEX_MODEL = "fixture-environment-model";
      const overridden = await checkConnection(connectionRequest({ provider: "codex", model: "fixture-ignored-draft" }));
      const second = await overridden.json() as { codexStatus: { service: string; model: string } };
      assert.equal(overridden.status, 200);
      assert.equal(second.codexStatus.model, "fixture-environment-model");
      const call = fixture.calls().at(-1)!;
      assert.equal(call.args[call.args.indexOf("-m") + 1], "fixture-environment-model");
      delete process.env.KB_CODEX_MODEL;
      const blank = await checkConnection(connectionRequest({ provider: "codex", model: "" }));
      assert.equal(blank.status, 200);
      assert.equal(fixture.calls().at(-1)?.args.includes("-m"), false, "an empty draft tests the CLI default rather than the old saved model");
      fixture.setMode("quota");
      const failed = await checkConnection(connectionRequest({ provider: "codex", model: "fixture-draft-model" }));
      assert.equal(failed.status, 200, "a completed status check reports availability in its payload");
      const failedBody = await failed.json() as { codexStatus: { service: string; errorStatus: number } };
      assert.equal(failedBody.codexStatus.service, "unavailable");
      assert.equal(failedBody.codexStatus.errorStatus, 429);
      assert.deepEqual(store.snapshot(), before);
      assert.equal(readFileSync(mirror, "utf8"), beforeMirror);
      for (const invocation of fixture.calls())
        assert.doesNotMatch(invocation.input, /PRIVATE_PAPER_ABSTRACT_DO_NOT_SEND|PRIVATE_PERSONAL_NOTE_DO_NOT_SEND|Private paper/);
    } finally { store.close(); }
  });
});

test("Codex probe HTTP route rejects arbitrary prompts, invalid bodies and cross-site requests before execution", async () => {
  await withFixture(async fixture => {
    fixture.setMode("probe-ok");
    for (const body of [
      { provider: "codex", model: "fixture-model", prompt: "Never accepted" },
      { provider: "ollama", model: "fixture-model" },
      { provider: "codex", model: 7 },
      { provider: "codex", model: "x".repeat(2000) },
      { provider: "codex", model: "fixture-model", paperId: "not-used-by-probes" },
      {},
    ]) {
      const response = await checkConnection(connectionRequest(body));
      assert.equal(response.status, 400);
    }
    const malformed = await checkConnection(new Request("http://localhost/api/kb/ai/check", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
    }));
    assert.equal(malformed.status, 400);
    const rejectedHeaders: Array<Record<string, string>> = [
      { Origin: "https://untrusted.example" },
      { "Sec-Fetch-Site": "cross-site" },
      { Host: "untrusted.example" },
    ];
    for (const headers of rejectedHeaders) {
      const response = await checkConnection(connectionRequest({ provider: "codex", model: "fixture-model" }, headers));
      assert.equal(response.status, 403);
    }
    assert.equal(fixture.calls().length, 0, "no rejected request may start Codex exec");
  });
});
