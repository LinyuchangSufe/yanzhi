import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StoreError } from "../db";
import { validatePNG } from "./pdf-image";

// Adapted from Papernook src/lib/agent/codex.ts and invocation.ts (MIT).
// Keep the CLI's credential handling inside the CLI; never read or return tokens.
export function codexEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV || "production",
  };
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "CODEX_HOME",
    "CODEX_API_KEY",
  ])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  return environment;
}

function failure(diagnostic: string): StoreError {
  if (/(?:image|vision|multimodal)[\s\S]*(?:not support|unsupported|not allowed|not accept)|(?:not support|unsupported)[\s\S]*(?:image|vision|multimodal)/i.test(diagnostic))
    return new StoreError("当前 Codex 模型不支持图像识别，请选择支持图像的模型；未退回纯文本猜测公式。", 422);
  if (
    /rate.?limit|usage.?limit|too many requests|quota|429|usage_limit_reached/i.test(
      diagnostic,
    )
  )
    return new StoreError(
      "Codex 额度已用完或请求过于频繁，请稍后重试或切换提供方；原有内容已保留。",
      429,
    );
  if (
    /unauthorized|authentication|not logged in|401|token.expired/i.test(
      diagnostic,
    )
  )
    return new StoreError(
      "Codex 尚未登录或授权已过期，请在本机终端运行 codex login 后重新检测。",
      422,
    );
  if (
    /model.*(?:not found|not supported|unavailable|does not exist)/i.test(
      diagnostic,
    )
  )
    return new StoreError(
      "Codex 模型不可用，请在设置中清空模型名使用默认模型，或填写账户可用的模型。",
      422,
    );
  if (
    /network|connection|fetch failed|dns|tls|certificate|connect.*timed out/i.test(
      diagnostic,
    )
  )
    return new StoreError(
      "无法连接 Codex 模型服务，请检查网络、代理及证书设置后重新测试。",
      502,
    );
  // CLI diagnostics can contain prompt fragments, paths, or credentials. Do not relay them.
  return new StoreError(
    "Codex 调用失败，请检查 CLI 登录、网络和模型设置；原有内容已保留。",
    502,
  );
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

interface ProcessOptions {
  cwd: string;
  input?: string;
  signal?: AbortSignal;
  timeout: number;
  timeoutMessage?: string;
  onLine?: (line: string) => void;
}
async function invoke(args: string[], options: ProcessOptions) {
  if (options.signal?.aborted)
    throw new StoreError("Codex 请求已取消，未保存新结果。", 499);
  return new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve, reject) => {
      const child = spawn(
        process.env.KB_CODEX_BIN || process.env.CODEX_CLI_PATH || "codex",
        args,
        {
          cwd: options.cwd,
          env: codexEnvironment(),
          shell: false,
          // codex can be a Node wrapper around a native child. Terminate the whole
          // invocation so a timed-out wrapper cannot leave a model request running.
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "",
        pending = "",
        bytes = 0;
      let problem: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const terminate = (signal: NodeJS.Signals) => {
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, signal);
          } catch {
            /* Already exited. */
          }
        } else child.kill(signal);
      };
      // Next's graceful SIGTERM handler calls process.exit. Do not leave a
      // detached native CLI request behind when the local server shuts down.
      const onExit = () => terminate("SIGKILL");
      process.once("exit", onExit);
      const stop = (error: Error) => {
        if (problem) return;
        problem = error;
        terminate("SIGTERM");
        killTimer = setTimeout(() => terminate("SIGKILL"), 1000);
        killTimer.unref();
      };
      const cancel = () =>
        stop(new StoreError("Codex 请求已取消，未保存新结果。", 499));
      options.signal?.addEventListener("abort", cancel, { once: true });
      // Close the race between the pre-spawn check and listener registration.
      if (options.signal?.aborted) cancel();
      const timer = setTimeout(
        () =>
          stop(
            new StoreError(
              options.timeoutMessage ||
                "Codex 请求超时，请重试或减少选段长度；原有内容已保留。",
              502,
            ),
          ),
        options.timeout,
      );
      const cleanup = () => {
        process.removeListener("exit", onExit);
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", cancel);
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2_000_000) {
          stop(new StoreError("Codex 响应过大，未保存。", 502));
          return;
        }
        stdout += chunk;
        if (!options.onLine || problem) return;
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        try {
          for (const line of lines) if (line.trim()) options.onLine(line);
        } catch (error) {
          stop(
            error instanceof Error
              ? error
              : new StoreError("Codex 响应格式无效，未保存。", 502),
          );
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-16000);
      });
      child.stdin.on("error", () => {
        /* Early CLI exit is reported by close/error. */
      });
      child.on("error", () => {
        cleanup();
        reject(
          problem ||
            new StoreError(
              "无法启动 Codex CLI，请确认已安装并可运行 codex；可通过 KB_CODEX_BIN 指定路径。",
              422,
            ),
        );
      });
      child.on("close", (code) => {
        cleanup();
        if (!problem && pending.trim() && options.onLine) {
          try {
            options.onLine(pending);
          } catch (error) {
            problem =
              error instanceof Error
                ? error
                : new StoreError("Codex 响应格式无效，未保存。", 502);
          }
        }
        if (problem) reject(problem);
        else resolve({ stdout, stderr, code });
      });
      child.stdin.end(options.input || "");
    },
  );
}

export interface CodexStatus {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  message: string;
}
export async function checkCodex(signal?: AbortSignal): Promise<CodexStatus> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "kb-codex-check-"));
  try {
    const version = await invoke(["--version"], { cwd, signal, timeout: 8000 });
    if (version.code !== 0)
      return {
        installed: false,
        authenticated: false,
        message: "Codex CLI 无法运行，请检查安装或 KB_CODEX_BIN。",
      };
    // Only return an allowlisted version token; never pass raw CLI output to the UI.
    const label = version.stdout.match(/codex(?:-cli)?\s+[\w.+-]+/i)?.[0];
    const login = await invoke(["login", "status"], {
      cwd,
      signal,
      timeout: 8000,
    });
    const authenticated =
      login.code === 0 &&
      /logged in|authenticated/i.test(login.stdout + login.stderr) &&
      !/not logged in|unauthenticated/i.test(login.stdout + login.stderr);
    return {
      installed: true,
      authenticated,
      ...(label ? { version: label } : {}),
      message: authenticated
        ? "Codex CLI 已安装并登录；检测不运行模型，实际生成仍取决于网络、模型与账户额度。"
        : "Codex CLI 已安装但未检测到有效登录，请在本机终端运行 codex login。",
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      installed: false,
      authenticated: false,
      message: "无法检测 Codex CLI，请检查安装、运行权限或 KB_CODEX_BIN。",
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

let running = false;
export function acquireCodexRequest() {
  if (running) throw new StoreError("已有 Codex 请求正在运行，请等待完成后再试。", 409);
  running = true;
  return () => { running = false; };
}
export { failure as codexFailure };
export async function runCodex(input: {
  prompt: string;
  model?: string;
  summary: boolean;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  maxDurationMs?: number;
  images?: Uint8Array[];
  reasoningEffort?: "low";
  /** Genuine CLI JSONL output only; never simulate tokens from a completed result. */
  onDelta?: (text: string) => void;
}): Promise<{ text: string; model: string }> {
  if (input.images && (input.images.length < 1 || input.images.length > 4))
    throw new StoreError("图像输入数量超出识别范围。", 400);
  input.images?.forEach(validatePNG);
  const release = acquireCodexRequest();
  let cwd: string | undefined;
  try {
    cwd = await mkdtemp(path.join(os.tmpdir(), "kb-codex-run-"));
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "-c",
      "mcp_servers={}",
      "-c",
      'web_search="disabled"',
      "-c",
      "features.shell_tool=false",
      "-c",
      "features.apps=false",
      "-c",
      "features.multi_agent=false",
      "-c",
      "features.hooks=false",
      "-c",
      "features.plugins=false",
      "-c",
      "features.memories=false",
      "-c",
      "features.goals=false",
      "-c",
      "features.browser_use=false",
      "-c",
      "features.browser_use_external=false",
      "-c",
      "features.computer_use=false",
      "-c",
      "features.in_app_browser=false",
      "-c",
      "features.image_generation=false",
      "-c",
      "features.unified_exec=false",
      "-c",
      "features.workspace_dependencies=false",
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      'approval_policy="never"',
      "-s",
      "read-only",
      "--skip-git-repo-check",
    ];
    if (input.model?.trim()) args.push("-m", input.model.trim());
    // Keep quick reading tasks independent of the user's global Codex settings.
    // Explanation, summaries and note assistance omit this per-call override.
    if (input.reasoningEffort) args.push("-c", `model_reasoning_effort="${input.reasoningEffort}"`);
    for (const [index, bytes] of (input.images || []).entries()) {
      const image = path.join(cwd, `source-${index + 1}.png`);
      await writeFile(image, bytes, { mode: 0o600 });
      args.push("--image", image);
    }
    if (input.summary || input.outputSchema) {
      const schema = path.join(cwd, "summary.schema.json");
      await writeFile(
        schema,
        JSON.stringify(
          input.outputSchema || {
            type: "object",
            properties: {
              researchProblem: { type: "string" },
              coreMethod: { type: "string" },
              mainContributions: { type: "string" },
            },
            required: ["researchProblem", "coreMethod", "mainContributions"],
            additionalProperties: false,
          },
        ),
        { mode: 0o600 },
      );
      args.push("--output-schema", schema);
    }
    args.push("-");
    let text = "",
      completed = false,
      diagnostic = "",
      model = input.model?.trim() || "cli-default";
    const streamedMessages = new Map<string, string>();
    const configuredTimeout = Number(process.env.KB_CODEX_TIMEOUT_MS);
    const configuredLimit =
      Number.isFinite(configuredTimeout) && configuredTimeout >= 100
        ? Math.min(configuredTimeout, 300000)
        : 180000;
    const timeout = Math.min(configuredLimit, input.maxDurationMs || 300000);
    const result = await invoke(args, {
      cwd,
      input: input.prompt,
      signal: input.signal,
      timeout,
      ...(input.maxDurationMs
        ? { timeoutMessage: "Codex 连接测试超时，请检查网络或稍后重试。" }
        : {}),
      onLine(line) {
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch {
          throw new StoreError(
            "Codex 响应格式无效，未保存。请检查 CLI 版本。",
            502,
          );
        }
        const event = record(value);
        if (!event || typeof event.type !== "string")
          throw new StoreError("Codex 响应格式无效，未保存。", 502);
        if (typeof event.model === "string") model = event.model;
        const item = record(event.item);
        if (
          item &&
          [
            "command_execution",
            "mcp_tool_call",
            "web_search",
            "file_change",
            "collab_tool_call",
          ].includes(String(item.type))
        )
          throw new StoreError(
            "Codex 尝试调用阅读任务以外的工具，已停止且未保存。",
            502,
          );
        if (
          ["item.updated", "item.completed"].includes(event.type) &&
          item?.type === "agent_message" &&
          typeof item.text === "string"
        ) {
          const key = typeof item.id === "string" ? item.id : "agent_message";
          const previous = streamedMessages.get(key) || "";
          if (!item.text.startsWith(previous)) throw new StoreError("Codex 流式正文发生不兼容修改，请重试。", 502);
          const delta = item.text.slice(previous.length);
          if (delta) input.onDelta?.((streamedMessages.size && !streamedMessages.has(key) ? "\n\n" : "") + delta);
          streamedMessages.set(key, item.text);
          if (event.type === "item.completed") text = [...streamedMessages.values()].join("\n\n");
        }
        if (event.type === "error" || event.type === "turn.failed")
          diagnostic += JSON.stringify(event).slice(0, 16000);
        if (event.type === "turn.completed") completed = true;
      },
    });
    if (result.code !== 0 || diagnostic)
      throw failure(diagnostic + "\n" + result.stderr);
    if (!completed || !text.trim() || text.length > 500000)
      throw new StoreError("Codex 未返回完整有效正文，未保存新结果。", 502);
    if (input.signal?.aborted)
      throw new StoreError("Codex 请求已取消，未保存新结果。", 499);
    return { text, model };
  } finally {
    try {
      if (cwd) await rm(cwd, { recursive: true, force: true });
    } finally {
      release();
    }
  }
}
