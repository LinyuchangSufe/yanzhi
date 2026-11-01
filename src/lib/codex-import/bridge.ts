import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { StoreError } from "../store-error";
import { createReadOnlyTransport, historyBinary, HistoryRpcError, type HistoryTransport } from "./protocol";
import type { CodexHistory, CodexSource, CodexThread, CodexTurn, ExternalMessage } from "./types";

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const invalid = () => new StoreError("Codex 历史结构不完整，未截断或导入。请更新 CLI 后重试。", 502);
const text = (value: unknown, maximum = 1000) => {
  if (typeof value !== "string" || value.length > maximum) throw invalid();
  return value;
};
const id = (value: unknown) => { const valueText = text(value, 256); if (!valueText.trim()) throw invalid(); return valueText; };
const array = (value: unknown): unknown[] => { if (!Array.isArray(value)) throw invalid(); return value; };
function iso(value: unknown, nullable = false): string | null {
  if (nullable && value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid();
  const date = new Date(value * 1000); if (!Number.isFinite(date.getTime())) throw invalid();
  return date.toISOString();
}
function thread(value: unknown): CodexThread {
  const item = row(value); if (!item) throw invalid();
  const title = typeof item.name === "string" && item.name.trim() ? item.name : "未命名 Codex 讨论";
  return { id: id(item.id), title: text(title, 2000), cwd: text(item.cwd, 16000), createdAt: iso(item.createdAt)!, updatedAt: iso(item.updatedAt)! };
}
function cursor(value: unknown): string | null {
  if (value === null) return null;
  return text(value, 10000);
}
function sourceIdentity(source: Omit<CodexSource, "id">): CodexSource {
  return { ...source, id: createHash("sha256").update(JSON.stringify([source.host, source.home, source.sqliteHome])).digest("hex") };
}
export function codexHistorySource(): CodexSource {
  const home = path.resolve(process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), ".codex"));
  return sourceIdentity({ label: `本机 Codex · ${home}`, host: os.hostname(), home,
    sqliteHome: process.env.CODEX_SQLITE_HOME ? path.resolve(process.env.CODEX_SQLITE_HOME) : null, binary: historyBinary() });
}
export interface HistoryBridgeOptions {
  open?: (signal?: AbortSignal) => HistoryTransport;
  source?: CodexSource;
  maxTurns?: number;
  maxItems?: number;
  maxTextBytes?: number;
}
export function createCodexHistoryBridge(options: HistoryBridgeOptions = {}) {
  const maxTurns = options.maxTurns ?? 2000, maxItems = options.maxItems ?? 50_000, maxTextBytes = options.maxTextBytes ?? 10_000_000;
  async function connect<T>(signal: AbortSignal | undefined, run: (transport: HistoryTransport, source: CodexSource) => Promise<T>): Promise<T> {
    const configuredSource = options.source || codexHistorySource();
    const transport = options.open ? options.open(signal) : createReadOnlyTransport(signal, { binary: configuredSource.binary });
    try {
      const initialized = row(await transport.request("initialize", { clientInfo: { name: "yanzhi_history_reader", title: "研知只读历史", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } }));
      if (!initialized) throw invalid();
      const actualHome = typeof initialized.codexHome === "string" ? path.resolve(initialized.codexHome) : configuredSource.home;
      if (process.env.CODEX_HOME && !options.source && actualHome !== configuredSource.home)
        throw new StoreError("Codex 返回的 profile 与 CODEX_HOME 不一致。请核对网页服务与桌面使用的 CLI 和数据目录。", 409);
      const source = sourceIdentity({ ...configuredSource, home: actualHome, label: `本机 Codex · ${actualHome}` });
      return await run(transport, source);
    } finally { await transport.close(); }
  }
  return {
    async listCodexThreads(input: { cursor?: string; search?: string; cwd?: string } = {}, signal?: AbortSignal) {
      return connect(signal, async (transport, source) => {
        const response = row(await transport.request("thread/list", { limit: 40, sortKey: "updated_at", sortDirection: "desc",
          sourceKinds: ["cli", "vscode", "appServer"], useStateDbOnly: true, archived: false,
          ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.search?.trim() ? { searchTerm: input.search.trim() } : {}), ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}) }));
        if (!response) throw invalid();
        const data = array(response.data); if (data.length > 1000) throw invalid();
        return { data: data.map(thread), nextCursor: cursor(response.nextCursor), source };
      });
    },
    async readCodexHistory(threadId: string, signal?: AbortSignal): Promise<CodexHistory> {
      if (!threadId.trim() || threadId.length > 256) throw new StoreError("请选择有效的 Codex 会话。", 400);
      return connect(signal, async (transport, source) => {
        const metadataResponse = row(await transport.request("thread/read", { threadId, includeTurns: false }));
        const metadata = row(metadataResponse?.thread); if (!metadata) throw invalid();
        const selectedThread = thread(metadata); if (selectedThread.id !== threadId) throw invalid();
        const turns: CodexTurn[] = [], turnIds = new Set<string>(), itemIds = new Set<string>();
        let itemCount = 0, publicBytes = 0;
        const project = (raw: unknown, turnId: string): ExternalMessage | null => {
          if (++itemCount > maxItems) throw new StoreError("会话条目超过本次读取上限，未截断或导入。", 413);
          const item = row(raw); if (!item) throw invalid();
          const itemId = id(item.id);
          if (itemIds.has(`${turnId}:${itemId}`)) throw new StoreError("Codex 历史分页出现重复条目，请稍后重新读取。", 409);
          itemIds.add(`${turnId}:${itemId}`);
          let value = "", role: ExternalMessage["role"];
          if (item.type === "userMessage") {
            role = "user";
            value = array(item.content).map((part) => {
              const content = row(part); if (!content) throw invalid();
              return content.type === "text" ? text(content.text, maxTextBytes) : "";
            }).filter(Boolean).join("\n");
          } else if (item.type === "agentMessage") { role = "assistant"; value = text(item.text, maxTextBytes); }
          else return null;
          if (!value.trim()) return null;
          publicBytes += Buffer.byteLength(value);
          if (publicBytes > maxTextBytes) throw new StoreError("公开消息超过本次读取上限，未截断或导入。", 413);
          return { id: itemId, turnId, role, text: value };
        };
        const addTurn = async (raw: unknown, paginated: boolean) => {
          const turn = row(raw); if (!turn) throw invalid();
          const turnId = id(turn.id);
          if (turnIds.has(turnId)) throw new StoreError("Codex 历史分页发生变化，请重新读取后选择轮次。", 409);
          if (turns.length >= maxTurns) throw new StoreError("会话轮次超过本次读取上限，未截断或导入。", 413);
          turnIds.add(turnId);
          let items = array(turn.items);
          if (paginated && turn.itemsView !== "full") {
            items = [];
            let next: string | null = null;
            let pages = 0;
            const seen = new Set<string>();
            do {
              if (++pages > 500) throw new StoreError("会话条目分页超过本次读取上限，未截断或导入。", 413);
              const result = row(await transport.request("thread/items/list", { threadId, turnId, limit: 200, sortDirection: "asc", ...(next ? { cursor: next } : {}) }));
              if (!result) throw invalid();
              for (const entry of array(result.data)) {
                const item = row(entry); if (!item || item.turnId !== turnId) throw invalid();
                items.push(item.item);
                if (items.length + itemCount > maxItems) throw new StoreError("会话条目超过本次读取上限，未截断或导入。", 413);
              }
              next = cursor(result.nextCursor);
              if (next && seen.has(next)) throw new StoreError("Codex 历史分页游标重复，请稍后重试。", 409);
              if (next) seen.add(next);
            } while (next);
          } else if (!paginated && turn.itemsView && turn.itemsView !== "full") throw invalid();
          turns.push({ id: turnId, status: typeof turn.status === "string" ? turn.status : "unknown", startedAt: iso(turn.startedAt, true),
            messages: items.map((item) => project(item, turnId)).filter((item): item is ExternalMessage => item !== null) });
        };
        let protocol: CodexHistory["protocol"] = "paginated";
        let paginatedStarted = false;
        try {
          let next: string | null = null;
          let pages = 0;
          const seen = new Set<string>();
          do {
            if (++pages > 500) throw new StoreError("会话轮次分页超过本次读取上限，未截断或导入。", 413);
            const result = row(await transport.request("thread/turns/list", { threadId, limit: 100, sortDirection: "asc", itemsView: "full", ...(next ? { cursor: next } : {}) }));
            paginatedStarted = true;
            if (!result) throw invalid();
            for (const turn of array(result.data)) await addTurn(turn, true);
            next = cursor(result.nextCursor);
            if (next && seen.has(next)) throw new StoreError("Codex 历史分页游标重复，请稍后重试。", 409);
            if (next) seen.add(next);
          } while (next);
        } catch (error) {
          if (!(error instanceof HistoryRpcError) || error.rpcCode !== -32601 || paginatedStarted || metadata.historyMode === "paginated") throw error;
          protocol = "legacy";
          const response = row(await transport.request("thread/read", { threadId, includeTurns: true }));
          const full = row(response?.thread); if (!full || full.id !== threadId || full.historyMode === "paginated") throw invalid();
          for (const turn of array(full.turns)) await addTurn(turn, false);
        }
        const finalResponse = row(await transport.request("thread/read", { threadId, includeTurns: false }));
        const finalThread = thread(finalResponse?.thread);
        if (finalThread.id !== threadId || finalThread.updatedAt !== selectedThread.updatedAt)
          throw new StoreError("原 Codex 会话在读取期间有更新，请重新读取后选择轮次。", 409);
        return { thread: selectedThread, turns, complete: true, source, protocol };
      });
    },
  };
}
export const listCodexThreads = (input: { cursor?: string; search?: string; cwd?: string } = {}, signal?: AbortSignal) => createCodexHistoryBridge().listCodexThreads(input, signal);
export const readCodexHistory = (threadId: string, signal?: AbortSignal) => createCodexHistoryBridge().readCodexHistory(threadId, signal);
