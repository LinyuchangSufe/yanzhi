import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { MetadataCandidate } from "../import/enrichment-types";
import { StoreError } from "../store-error";
import type { ResolvedLiteratureContext } from "./context";

const ttl = 30 * 60 * 1000, maximum = 1000, byteLimit = 24 * 1024 * 1024;
interface CachedCandidate { storePath: string; context: ResolvedLiteratureContext; candidate: MetadataCandidate; expiresAt: number; bytes: number }
// Next route bundles may load separate module copies in one server process.
// Share only this bounded server cache so chat-created tokens work in import routes.
const runtime = globalThis as typeof globalThis & { __yanzhiLiteratureCandidates?: { secret: Buffer; candidates: Map<string, CachedCandidate> } };
const shared = runtime.__yanzhiLiteratureCandidates ??= { secret: randomBytes(32), candidates: new Map() };
const { secret, candidates } = shared;
const signature = (body: string) => createHmac("sha256", secret).update(body).digest("hex");
export function cacheLiteratureCandidate(storePath: string, context: ResolvedLiteratureContext, candidate: MetadataCandidate): string {
  const expiresAt = Date.now() + ttl;
  const value = { storePath, context, candidate, expiresAt };
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > byteLimit) throw new StoreError("文献候选过大，请缩小查询范围后重试。", 413);
  for (const [key, value] of candidates) if (value.expiresAt <= Date.now()) candidates.delete(key);
  let retainedBytes = [...candidates.values()].reduce((sum, item) => sum + item.bytes, 0);
  while (candidates.size >= maximum || retainedBytes + bytes > byteLimit) {
    const oldest = candidates.keys().next().value!; retainedBytes -= candidates.get(oldest)!.bytes; candidates.delete(oldest);
  }
  const body = `${randomBytes(20).toString("hex")}.${expiresAt}`;
  candidates.set(body, structuredClone({ ...value, bytes }));
  return `${body}.${signature(body)}`;
}
export function readLiteratureCandidate(token: string, storePath: string): CachedCandidate {
  const parts = token.split("."), body = parts.slice(0, 2).join("."), signed = parts[2];
  const expected = signature(body);
  if (parts.length !== 3 || !signed || !/^[a-f0-9]{64}$/.test(signed) || !timingSafeEqual(Buffer.from(signed), Buffer.from(expected)))
    throw new StoreError("文献候选无效，请重新查询后选择。", 409);
  const cached = candidates.get(body);
  if (!cached || cached.storePath !== storePath || cached.expiresAt <= Date.now()) {
    if (cached?.expiresAt && cached.expiresAt <= Date.now()) candidates.delete(body);
    throw new StoreError("文献候选已过期或服务已重启，请重新查询后选择。", 409);
  }
  return structuredClone(cached);
}
