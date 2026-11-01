import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

test("server process.exit kills a detached fake CLI wrapper and TERM-ignoring descendant", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kb-codex-exit-"));
  const executable = path.join(root, "fake codex.mjs"), parentScript = path.join(root, "parent.mjs");
  const wrapperFile = path.join(root, "wrapper.json"), descendantFile = path.join(root, "descendant.json");
  const normalFile = path.join(root, "normal-cleanup.json"), errorFile = path.join(root, "parent-error.txt");
  const descendantScript = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(descendantFile)}, JSON.stringify({pid:process.pid,ppid:process.ppid})); setInterval(() => {}, 1000);`;
  writeFileSync(executable, `#!${process.execPath}
import fs from 'node:fs';
import {spawn} from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] !== 'exec') process.exit(3);
let input = '';
for await (const part of process.stdin) input += part;
if (input === 'COMPLETE_SYNTHETIC_FIXTURE') {
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Synthetic boundary fixture; no model was called.'}}));
  console.log(JSON.stringify({type:'turn.completed'}));
} else if (input === 'EXIT_WITH_SYNTHETIC_DESCENDANT') {
  process.on('SIGTERM', () => {});
  fs.writeFileSync(${JSON.stringify(wrapperFile)}, JSON.stringify({pid:process.pid,args,cwd:process.cwd()}));
  spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], {stdio:['ignore','inherit','inherit']});
  setInterval(() => {}, 1000);
} else process.exit(4);
`);
  chmodSync(executable, 0o700);
  writeFileSync(parentScript, `import fs from 'node:fs';
import assert from 'node:assert/strict';
import {runCodex} from ${JSON.stringify(pathToFileURL(path.resolve("src/lib/ai/codex.ts")).href)};
process.env.KB_CODEX_BIN = ${JSON.stringify(executable)};
process.env.KB_CODEX_TIMEOUT_MS = '30000';
const before = process.listenerCount('exit');
await runCodex({prompt:'COMPLETE_SYNTHETIC_FIXTURE',summary:false});
const after = process.listenerCount('exit');
assert.equal(after, before, 'completed calls must remove their exit listener');
fs.writeFileSync(${JSON.stringify(normalFile)}, JSON.stringify({before,after}));
void runCodex({prompt:'EXIT_WITH_SYNTHETIC_DESCENDANT',summary:false}).catch(error => {
  fs.writeFileSync(${JSON.stringify(errorFile)}, String(error)); process.exit(2);
});
const started = Date.now();
const ready = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(wrapperFile)}) && fs.existsSync(${JSON.stringify(descendantFile)})) {
    clearInterval(ready);
    fs.writeSync(1, 'Both synthetic descendants started; exiting server process now.\\n');
    process.exit(0);
  }
  if (Date.now() - started > 5000) { fs.writeFileSync(${JSON.stringify(errorFile)}, 'Fixture readiness timed out'); process.exit(2); }
}, 10);
`);
  const parent = spawn(process.execPath, ["--import", "tsx", parentScript], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, NODE_ENV: "test" },
  });
  let output = "", watchdogUsed = false;
  for (const stream of [parent.stdout, parent.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-4000); });
  const cleanup = () => {
    // This watchdog is test containment only; a successful test never uses it.
    if (existsSync(wrapperFile)) {
      const { pid } = JSON.parse(readFileSync(wrapperFile, "utf8")) as { pid: number };
      try { process.kill(-pid, "SIGKILL"); } catch { /* Already terminated. */ }
    }
    if (existsSync(descendantFile)) {
      const { pid } = JSON.parse(readFileSync(descendantFile, "utf8")) as { pid: number };
      try { process.kill(pid, "SIGKILL"); } catch { /* Already terminated. */ }
    }
    if (parent.exitCode === null) parent.kill("SIGKILL");
  };
  const watchdog = setTimeout(() => { watchdogUsed = true; cleanup(); }, 9000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      parent.once("error", reject); parent.once("exit", resolve);
    });
    assert.equal(code, 0, existsSync(errorFile) ? readFileSync(errorFile, "utf8") : output);
    assert.equal(watchdogUsed, false);
    assert.match(output, /Both synthetic descendants started/);
    assert.equal(existsSync(normalFile), true, "A completed request verified exit-listener cleanup first");
    const normal = JSON.parse(readFileSync(normalFile, "utf8")) as { before: number; after: number };
    assert.equal(normal.after, normal.before);
    const wrapper = JSON.parse(readFileSync(wrapperFile, "utf8")) as { pid: number; args: string[] };
    const descendant = JSON.parse(readFileSync(descendantFile, "utf8")) as { pid: number; ppid: number };
    assert.equal(descendant.ppid, wrapper.pid);
    assert.ok(wrapper.args.includes("features.goals=false"), "Reading-only Codex requests must also disable goals");
    for (let attempt = 0; attempt < 150 && (alive(wrapper.pid) || alive(descendant.pid)); attempt++) await pause(20);
    assert.equal(alive(wrapper.pid), false, "The detached CLI wrapper must not survive server process.exit");
    assert.equal(alive(descendant.pid), false, "Its TERM-ignoring child with inherited pipes must not survive");
    assert.equal(watchdogUsed, false, "Provider shutdown, not the watchdog, must terminate both processes");
  } finally {
    clearTimeout(watchdog); cleanup(); rmSync(root, { recursive: true, force: true });
  }
});
