import { z } from "zod";
import { StoreError } from "../store-error";

export interface ControlledChatTool {
  name: string; description: string; inputSchema: Record<string, unknown>;
  call(args: unknown, signal: AbortSignal): Promise<string>;
}
type Row = Record<string, unknown>;
const record = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const querySchema = z.object({ query: z.string().trim().min(1).max(1000) }).strict();
const failure = (reason: string) => new StoreError("文献工具调用校验失败，请重试", 502,
  { code: "LITERATURE_TOOL_PROTOCOL", reason });
const MAX_LOOKUPS = 12;
const MAX_CALLS = 64;
type Call = { args: string; requested: boolean; responded: boolean; completed: boolean };
type Job = { id: string | number; call: Call; args: { query: string } };

/** An explicit capability for public bibliography lookup; never a general tool executor. */
export function createControlledToolSession(
  tools: readonly ControlledChatTool[], scope: () => { threadId: string; turnId: string }, signal: AbortSignal,
  respond: (value: unknown) => void, onFatal: (error: Error) => void,
) {
  if (tools.length > 1 || tools.some(tool => tool.name !== "lookup_literature")) throw failure("tool_spec");
  const tool = tools[0];
  const abort = new AbortController();
  const requestSignal = AbortSignal.any([signal, abort.signal]);
  const calls = new Map<string, Call>();
  const requestIds = new Set<string>();
  const queue: Job[] = [];
  let draining = false, disposed = false, executed = 0;
  const dispose = () => { disposed = true; queue.length = 0; abort.abort(); };
  const fatal = (error: unknown) => { dispose(); onFatal(error instanceof StoreError ? error : failure("tool_response")); };
  const checkScope = (params: Row) => {
    const current = scope();
    if (!current.threadId || !current.turnId || params.threadId !== current.threadId || params.turnId !== current.turnId) throw failure("scope");
  };
  const argumentsText = (value: unknown) => {
    let raw: string;
    try { raw = JSON.stringify(value); } catch { throw failure("arguments_encoding"); }
    if (!raw || Buffer.byteLength(raw) > 8192) throw failure("arguments_size");
    const parsed = querySchema.safeParse(value);
    if (!parsed.success) throw failure("arguments_schema");
    return JSON.stringify(parsed.data);
  };
  const itemFrom = (value: unknown) => {
    const params = record(value); if (!params) throw failure("item_shape"); checkScope(params);
    const item = record(params.item);
    if (!tool || !item || item.type !== "dynamicToolCall" || item.tool !== tool.name ||
        (item.namespace !== undefined && item.namespace !== null) || typeof item.id !== "string" || !item.id || item.id.length > 300) throw failure("item_identity");
    return item;
  };
  // Codex may issue several independent tool calls before any completes. Accept
  // their lifecycles separately; serialize only the actual public lookups so the
  // shared citation budget remains atomic and upstream services are not flooded.
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !disposed && !requestSignal.aborted) {
        const job = queue.shift()!;
        let text: string, success = true;
        if (executed >= MAX_LOOKUPS) {
          text = "已用完本轮 12 次检索额度，后续查询未执行。请用已返回的题录继续回答，明确未核实的文献；用户可在下一轮继续查找。尚未下载或入库。";
          success = false;
        } else {
          executed++;
          try {
            text = await tool!.call(job.args, requestSignal);
            if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 65536) throw new Error("invalid result");
          } catch {
            text = "文献检索未完成，尚未下载或入库。可重试，或使用页面中的查找文献入口。"; success = false;
          }
        }
        if (disposed || requestSignal.aborted) return;
        job.call.responded = true;
        respond({ id: job.id, result: { contentItems: [{ type: "inputText", text }], success } });
      }
    } finally { draining = false; }
  };
  return {
    specs: tools.map(({ name, description, inputSchema }) => ({ type: "function" as const, name, description, inputSchema })),
    started(params: unknown) {
      const item = itemFrom(params), id = item.id as string;
      if (disposed || requestSignal.aborted) throw failure("session_closed");
      if (calls.has(id)) throw failure("call_replay");
      if (calls.size >= MAX_CALLS) throw failure("protocol_call_limit");
      if (item.status !== "inProgress") throw failure("start_status");
      calls.set(id, { args: argumentsText(item.arguments), requested: false, responded: false, completed: false });
    },
    completed(params: unknown) {
      const item = itemFrom(params), call = calls.get(item.id as string);
      if (disposed || requestSignal.aborted || !call || !call.requested || !call.responded || call.completed || !["completed", "failed"].includes(String(item.status)) || argumentsText(item.arguments) !== call.args) throw failure("completion_lifecycle");
      call.completed = true;
    },
    handleRequest(id: string | number, value: unknown) {
      try {
        if (disposed || requestSignal.aborted || !tool || (typeof id !== "string" && typeof id !== "number")) throw failure("request_state");
        const requestKey = `${typeof id}:${id}`;
        if (requestIds.has(requestKey)) throw failure("request_replay");
        const params = record(value); if (!params) throw failure("request_shape"); checkScope(params);
        if (params.namespace !== null || params.tool !== tool.name || typeof params.callId !== "string") throw failure("request_identity");
        const call = calls.get(params.callId);
        if (!call || call.requested || argumentsText(params.arguments) !== call.args) throw failure("request_lifecycle");
        requestIds.add(requestKey); call.requested = true;
        queue.push({ id, call, args: querySchema.parse(params.arguments) });
        void drain().catch(error => { if (!disposed && !requestSignal.aborted) fatal(error); });
      } catch (error) { fatal(error); }
    },
    assertIdle() { if (queue.length || [...calls.values()].some(call => !call.requested || !call.responded || !call.completed)) throw failure("unfinished_calls"); },
    dispose,
  };
}
