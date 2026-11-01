import { lookup } from "node:dns/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isIP } from "node:net";
import { Agent, fetch, type Response } from "undici";
import { MAX_PDF_BYTES } from "../pdf-limits";
import { normalizeUrl, pdfUrlFromHtml } from "./normalize";
import { parseHtmlMetadata } from "./html-metadata";
import { pdfTitlesAgree } from "./metadata-title";
import { doiFromSourceUrl } from "./identifiers";

/**
 * Polite fetching: descriptive User-Agent (arxiv policy) and a per-host
 * cooldown so bursts of captures never hammer one origin.
 */

export const USER_AGENT =
  "papernook/0.1 (self-hosted paper library; +https://github.com/afromero)";
const HOST_COOLDOWN_MS = 3_000;
export { MAX_PDF_BYTES };
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
export const DOWNLOAD_TOTAL_TIMEOUT_MS = 90_000;
export const DOWNLOAD_REQUEST_TIMEOUT_MS = 60_000;

const lastFetchByHost = new Map<string, number>();

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) || // IETF protocol assignments
    (first === 192 && second === 0 && third === 2) || // TEST-NET-1
    (first === 192 && second === 88 && third === 99) || // 6to4 relay anycast
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) || // benchmarking
    (first === 198 && second === 51 && third === 100) || // TEST-NET-2
    (first === 203 && second === 0 && third === 113) // TEST-NET-3
  );
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(normalized);
  if (version === 4) return isPrivateIpv4(normalized);
  if (version !== 6) return true;

  const embeddedIpv4 = normalized.match(
    /^::(?:ffff:)?(?:(\d+\.\d+\.\d+\.\d+)|([a-f\d]{1,4}):([a-f\d]{1,4}))$/,
  );
  if (embeddedIpv4) {
    if (embeddedIpv4[1]) return isPrivateIpv4(embeddedIpv4[1]);
    const first = Number.parseInt(embeddedIpv4[2], 16);
    const second = Number.parseInt(embeddedIpv4[3], 16);
    return isPrivateIpv4(
      `${first >> 8}.${first & 0xff}.${second >> 8}.${second & 0xff}`,
    );
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    /^2002:/.test(normalized) || // 6to4 (embeds an IPv4 that may be private)
    /^2001:0:/.test(normalized) || // Teredo 2001::/32
    /^64:ff9b:/.test(normalized) // NAT64 well-known prefix
  );
}

interface PublicAddress {
  address: string;
  family: 4 | 6;
}

async function resolvePublicUrl(
  rawUrl: string,
): Promise<{ url: URL; address: PublicAddress }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CaptureError(`Not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CaptureError("Capture URLs must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new CaptureError("Capture URLs cannot include credentials.");
  }
  // Only the default web ports. A nonstandard port turns the authenticated
  // proxy into a port scanner: open vs. closed ports return distinguishable
  // errors. (url.port is "" for the scheme default.)
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new CaptureError("Capture URLs must use the default HTTP(S) port.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses: PublicAddress[] = family
    ? [{ address: hostname, family: family as 4 | 6 }]
    : (
        await lookup(url.hostname, { all: true, verbatim: true }).catch(() => {
          throw new CaptureError(`Could not resolve ${url.hostname}.`);
        })
      ).map(({ address, family: resolvedFamily }) => ({
        address,
        family: resolvedFamily === 6 ? 6 : 4,
      }));
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new CaptureError(
      "Capture URLs must resolve to public internet addresses.",
    );
  }
  return { url, address: addresses[0] };
}

export interface FetchedPublicResponse {
  response: Response;
  url: string;
  close: () => Promise<void>;
}

/** Fetch a public HTTP(S) URL with DNS pinning and redirect SSRF guards. */
export async function fetchPublicUrl(
  url: string,
  signal?: AbortSignal,
): Promise<FetchedPublicResponse> {
  signal?.throwIfAborted();
  let current = await resolvePublicUrl(url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    signal?.throwIfAborted();
    const currentUrl = current.url.toString();
    const host = current.url.hostname;
    const last = lastFetchByHost.get(host) ?? 0;
    const wait = last + HOST_COOLDOWN_MS - Date.now();
    if (wait > 0) await delay(wait, undefined, { signal });
    lastFetchByHost.set(host, Date.now());
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [current.address]);
            return;
          }
          callback(null, current.address.address, current.address.family);
        },
      },
    });
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "manual",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
        dispatcher,
      });
    } catch (error) {
      await dispatcher.close();
      signal?.throwIfAborted();
      throw new CaptureError(`Fetch failed for ${currentUrl}`, {
        cause: error,
      });
    }
    if (response.status < 300 || response.status >= 400) {
      return { response, url: currentUrl, close: () => dispatcher.close() };
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    await dispatcher.close();
    if (!location)
      throw new CaptureError("Redirect response did not include a location.");
    current = await resolvePublicUrl(new URL(location, currentUrl).toString());
  }
  throw new CaptureError(`Too many redirects (maximum ${MAX_REDIRECTS}).`);
}

export class CaptureError extends Error {
  readonly status: number;
  constructor(message: string, options?: ErrorOptions, status = 422) {
    super(message, options);
    this.name = "CaptureError";
    this.status = status;
  }
}

export interface DownloadedPdf {
  bytes: Buffer;
  finalUrl: string;
  arxivId: string | null;
}

/** Sniff bytes rather than trusting Content-Type, while retaining both limits. */
async function readBody(response: Response, close: () => Promise<void>): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) { await close(); return Buffer.alloc(0); }
  const chunks: Buffer[] = [];
  const prefix = Buffer.alloc(5);
  let prefixSize = 0;
  let size = 0;
  let limit: number | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      chunks.push(Buffer.from(value));
      size += value.byteLength;
      if (prefixSize < 5) {
        const count = Math.min(5 - prefixSize, value.byteLength);
        prefix.set(value.subarray(0, count), prefixSize);
        prefixSize += count;
      }
      if (!limit && size >= 5) {
        limit = looksLikePdf(prefix) ? MAX_PDF_BYTES : MAX_HTML_BYTES;
      }
      if (limit && (size > limit || Number(response.headers.get("content-length")) > limit)) {
        await reader.cancel();
        throw new CaptureError(limit === MAX_PDF_BYTES ? "PDF 超过 100 MiB 上限，请自行下载后压缩或拆分。" : "来源网页超过 2 MiB 读取上限，请提供该文章的直接 PDF 链接。", undefined, 413);
      }
    }
  } finally {
    reader.releaseLock();
    await close();
  }
  return Buffer.concat(chunks, size);
}

// Require the actual %PDF- magic bytes: a hostile origin can claim any
// Content-Type, and these bytes are re-served same-origin as application/pdf.
export function looksLikePdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

// Cap concurrent server-side downloads: each buffers up to MAX_PDF_BYTES in
// heap, so a burst of parallel /viewer/pdf loads could otherwise exhaust it.
// ponytail: fixed global cap; make it a fair per-profile queue if it ever
// becomes a throughput bottleneck for legitimate use.
const MAX_INFLIGHT_DOWNLOADS = 3;
let inflightDownloads = 0;
const downloadWaiters: Array<() => void> = [];

async function acquireDownloadSlot(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (inflightDownloads >= MAX_INFLIGHT_DOWNLOADS) {
    await new Promise<void>((resolve, reject) => {
      const grant = () => { signal.removeEventListener("abort", abort); inflightDownloads += 1; resolve(); };
      const abort = () => { const index = downloadWaiters.indexOf(grant); if (index >= 0) downloadWaiters.splice(index, 1); reject(signal.reason); };
      downloadWaiters.push(grant);
      signal.addEventListener("abort", abort, { once: true });
    });
    return;
  }
  inflightDownloads += 1;
}

function releaseDownloadSlot(): void {
  inflightDownloads -= 1;
  downloadWaiters.shift()?.();
}

export interface DownloadOptions {
  fetcher?: (url: string, signal?: AbortSignal) => Promise<FetchedPublicResponse>;
  signal?: AbortSignal;
  expectedDoi?: string;
  expectedTitle?: string;
}

function timedOut(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current.name === "TimeoutError" || ("code" in current && /TIMEOUT|ETIMEDOUT/.test(String(current.code)))) return true;
    current = current.cause;
  }
  return false;
}

/** Fetch only the selected article's advertised PDF; never guess paywall routes. */
export async function downloadPdf(input: string, options: DownloadOptions = {}): Promise<DownloadedPdf> {
  const timeout = AbortSignal.timeout(DOWNLOAD_TOTAL_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let acquired = false;
  try {
    await acquireDownloadSlot(signal);
    acquired = true;
    return await downloadPdfInner(input, { ...options, signal });
  } catch (error) {
    if (options.signal?.aborted) throw new CaptureError("已取消获取 PDF，原附件保持不变。", undefined, 499);
    if (signal.aborted || timedOut(error))
      throw new CaptureError("来源站点响应超时，请稍后重试或手动上传 PDF。", undefined, 504);
    if (error instanceof CaptureError && /[\u4e00-\u9fff]/.test(error.message)) throw error;
    throw new CaptureError("无法连接公开来源；请检查来源链接和网络，或自行下载 PDF 后上传。", { cause: error });
  } finally {
    if (acquired) releaseDownloadSlot();
  }
}

async function downloadPdfInner(input: string, options: DownloadOptions & { signal: AbortSignal }): Promise<DownloadedPdf> {
  let target;
  try {
    target = normalizeUrl(input);
  } catch {
    throw new CaptureError("请提供 HTTP/HTTPS 来源链接、DOI 或 arXiv 标识。", undefined, 400);
  }
  const sourceDoi = doiFromSourceUrl(target.url);
  if (options.expectedDoi && sourceDoi && sourceDoi !== options.expectedDoi.toLowerCase())
    throw new CaptureError("来源 DOI 与当前文献不一致，请先核对文献信息。", undefined, 409);
  const fetcher = options.fetcher ?? fetchPublicUrl;
  let url = target.url;
  // One article page and its advertised endpoint, including HTML PDF viewers.
  const visited = new Set<string>();
  for (let step = 0; step < 3; step += 1) {
    options.signal.throwIfAborted();
    if (visited.has(url)) break;
    visited.add(url);
    const result = await fetcher(url, AbortSignal.any([options.signal, AbortSignal.timeout(DOWNLOAD_REQUEST_TIMEOUT_MS)]));
    const expectedDoi = options.expectedDoi || sourceDoi;
    const finalDoi = doiFromSourceUrl(result.url);
    const finalArxiv = normalizeUrl(result.url).arxivId;
    const arxivConflict = target.arxivId && finalArxiv &&
      (target.arxivId.replace(/v\d+$/i, "") !== finalArxiv.replace(/v\d+$/i, "") ||
        (/v\d+$/i.test(target.arxivId) && /v\d+$/i.test(finalArxiv) && target.arxivId !== finalArxiv));
    if ((expectedDoi && finalDoi && finalDoi !== expectedDoi.toLowerCase()) || arxivConflict) {
      await result.response.body?.cancel();
      await result.close();
      throw new CaptureError("来源重定向到另一篇文献，已停止下载；请核对来源链接。", undefined, 409);
    }
    if (!result.response.ok) {
      await result.response.body?.cancel();
      await result.close();
      const status = result.response.status;
      if ([401, 402, 403].includes(status))
        throw new CaptureError(`来源站点限制自动访问或需要登录/订阅（HTTP ${status}）。请在浏览器中通过有权访问的来源下载，再添加 PDF 附件。`);
      if (status === 429) throw new CaptureError("来源站点请求过于频繁（HTTP 429），请稍后重试。", undefined, 429);
      if ([404, 410].includes(status)) throw new CaptureError(`来源 PDF 或页面已失效（HTTP ${status}），请更新来源链接或手动上传。`);
      throw new CaptureError(`来源站点暂时不可用（HTTP ${status}），请稍后重试。`, undefined, 502);
    }
    const bytes = await readBody(result.response, result.close);
    options.signal.throwIfAborted();
    if (looksLikePdf(bytes)) return { bytes, finalUrl: result.url, arxivId: target.arxivId };
    const html = bytes.toString("utf8");
    const page = parseHtmlMetadata(html);
    const found = pdfUrlFromHtml(html, result.url);
    if (!found && (/<title[^>]*>[^<]*(?:sign[ -]?in|log[ -]?in|access denied|just a moment|security check|登录|验证)/i.test(html) || /<input[^>]+type\s*=\s*["']?password/i.test(html) || /Incapsula incident ID|_Incapsula_Resource|distil_referrer/i.test(html)))
      throw new CaptureError("来源返回登录或访问验证页面，无法自动获取正文。请在浏览器下载后添加 PDF 附件。");
    if ((expectedDoi && page.doi && page.doi !== expectedDoi.toLowerCase()) ||
        (options.expectedTitle && page.title && !pdfTitlesAgree(options.expectedTitle, page.title)))
      throw new CaptureError("来源页面的 DOI 或标题与当前文献不一致，已停止下载；请核对来源后重试。", undefined, 409);
    if (!found) {
      throw new CaptureError("来源没有提供可确认的正文 PDF 链接，或返回了网页而非 PDF。请打开原文获取 PDF 后上传；系统不会猜测补充材料或绕过付费访问。");
    }
    const linkedDoi = doiFromSourceUrl(found);
    if (expectedDoi && linkedDoi && linkedDoi !== expectedDoi.toLowerCase())
      throw new CaptureError("页面中的 PDF 链接指向另一 DOI，已停止下载。", undefined, 409);
    url = found;
  }
  throw new CaptureError("来源反复跳转到网页，未取得有效 PDF。请在浏览器中下载后上传。");
}
