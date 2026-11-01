import { spawn } from "node:child_process";
import { StoreError } from "../store-error";

export const historyMethods = ["initialize", "thread/list", "thread/read", "thread/turns/list", "thread/items/list"] as const;
export type HistoryMethod = typeof historyMethods[number];
export interface HistoryTransport {
  request(method: HistoryMethod, params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export class HistoryRpcError extends StoreError {
  constructor(public readonly rpcCode: number) {
    super(rpcCode === -32601 || rpcCode === -32602
      ? "当前 Codex CLI 不支持所需的只读历史接口，请更新 CLI 或核对所选 CLI 路径。"
      : "无法读取此 Codex 历史，请确认会话仍在当前本机 profile 的状态索引中。", 502);
  }
}
export function historyBinary() {
  return process.env.KB_CODEX_BINARY || process.env.KB_CODEX_BIN || process.env.CODEX_CLI_PATH || "codex";
}
/** Preserve the selected local profile. Never change credentials, config, or state roots. */
export function historyEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV || "production" };
  for (const key of ["PATH", "HOME", "CODEX_HOME", "CODEX_SQLITE_HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "SYSTEMROOT", "PATHEXT"])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  return environment;
}
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** One bounded local stdio connection. No inference or mutation methods are exposed. */
export function createReadOnlyTransport(signal?: AbortSignal, options: { binary?: string; timeoutMs?: number; maxBytes?: number } = {}): HistoryTransport {
  if (signal?.aborted) throw new StoreError("已取消读取 Codex 历史。", 499);
  const child = spawn(options.binary || historyBinary(), ["app-server", "--listen", "stdio://"], {
    env: historyEnvironment(), shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  });
  const requests = new Map<number, { method: HistoryMethod; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 1, pending = "", bytes = 0, stopped = false, exited = false;
  let failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const kill = (name: NodeJS.Signals) => {
    try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch { /* This invocation already exited. */ }
  };
  const onExit = () => kill("SIGKILL");
  process.once("exit", onExit);
  const finish = () => {
    // A wrapper may close while its TERM-ignoring descendant still owns this group.
    kill("SIGKILL");
    exited = true; clearTimeout(deadline); if (killTimer) clearTimeout(killTimer);
    signal?.removeEventListener("abort", cancel); process.removeListener("exit", onExit);
    if (!stopped) fail(new StoreError("Codex 历史读取进程提前退出，请检查本机 CLI 和 profile。", 502));
    resolveClosed();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; clearTimeout(deadline); signal?.removeEventListener("abort", cancel);
    for (const request of requests.values()) request.reject(failure || new StoreError("历史读取连接已关闭。", 499));
    requests.clear(); child.stdin.end(); kill("SIGTERM");
    if (!exited) { killTimer = setTimeout(() => kill("SIGKILL"), 200); killTimer.unref(); }
  };
  const fail = (error: Error) => { failure ??= error; stop(); };
  const cancel = () => fail(new StoreError("已取消读取 Codex 历史。", 499));
  const deadline = setTimeout(() => fail(new StoreError("读取 Codex 历史超过时限，请缩小筛选范围或稍后重试。", 504)), options.timeoutMs ?? 45_000);
  signal?.addEventListener("abort", cancel, { once: true });
  child.stdin.on("error", () => { /* The process error or close event reports failure. */ });
  child.stdout.setEncoding("utf8");
  child.stderr.resume(); // Never relay raw diagnostics, which can include private history.
  child.stdout.on("data", (chunk: string) => {
    if (stopped) return;
    bytes += Buffer.byteLength(chunk);
    if (bytes > (options.maxBytes ?? 32_000_000)) { fail(new StoreError("此会话超过本次历史读取的传输上限，未截断或导入。", 413)); return; }
    pending += chunk;
    const lines = pending.split("\n"); pending = lines.pop() || "";
    try {
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = object(JSON.parse(line) as unknown);
        if (!message) throw new StoreError("Codex 历史接口返回了无效响应，请更新 CLI。", 502);
        if (message.method !== undefined) {
          if (message.id !== undefined) throw new StoreError("只读历史连接收到了工具或权限请求，已停止读取。", 502);
          continue;
        }
        if (typeof message.id !== "number") continue;
        const request = requests.get(message.id); if (!request) continue;
        requests.delete(message.id);
        if (message.error) {
          const code = object(message.error)?.code;
          request.reject(new HistoryRpcError(typeof code === "number" ? code : 0));
        } else {
          if (request.method === "initialize") child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
          request.resolve(message.result);
        }
      }
    } catch (error) {
      fail(error instanceof StoreError ? error : new StoreError("Codex 历史接口返回了无效响应，请更新 CLI。", 502));
    }
  });
  child.once("error", () => { fail(new StoreError("无法启动本机 Codex CLI。请检查安装或 KB_CODEX_BINARY 指定的路径。", 422)); if (!child.pid) finish(); });
  child.once("close", finish);
  if (signal?.aborted) cancel();
  return {
    request(method, params) {
      if (!historyMethods.includes(method)) return Promise.reject(new StoreError("只读历史连接不允许此操作。", 403));
      if (stopped) return Promise.reject(failure || new StoreError("历史读取连接已关闭。", 499));
      return new Promise((resolve, reject) => {
        const id = nextId++; requests.set(id, { method, resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    async close() { stop(); await closed; },
  };
}
