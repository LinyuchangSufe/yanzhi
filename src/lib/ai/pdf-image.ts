import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { StoreError } from "../db";
import type { AnnotationRect } from "../types";

const exec = promisify(execFile);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_EDGE = 2600;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new StoreError("AI 请求已取消，未保存新结果。", 499);
}

/** Images only originate from our renderer; reject non-PNG or unbounded image inputs. */
export function validatePNG(bytes: Uint8Array): { width: number; height: number } {
  const image = Buffer.from(bytes);
  if (image.length < 33 || image.length > MAX_IMAGE_BYTES ||
      !image.subarray(0, 8).equals(PNG_SIGNATURE) ||
      image.readUInt32BE(8) !== 13 || image.toString("ascii", 12, 16) !== "IHDR")
    throw new StoreError("PDF 页面图像格式或大小无效，未发送到模型。", 422);
  const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
  if (!width || !height || width > MAX_EDGE || height > MAX_EDGE)
    throw new StoreError("PDF 页面图像尺寸超出识别范围，未发送到模型。", 422);
  let offset = 8, hasData = false, ended = false;
  while (offset + 12 <= image.length) {
    const length = image.readUInt32BE(offset);
    if (length > image.length - offset - 12) break;
    const kind = image.toString("ascii", offset + 4, offset + 8);
    if (kind === "IDAT" && length > 0) hasData = true;
    offset += length + 12;
    if (kind === "IEND") { ended = length === 0 && offset === image.length; break; }
  }
  if (!hasData || !ended)
    throw new StoreError("PDF 页面图像数据不完整，未发送到模型。", 422);
  return { width, height };
}

/** Map unrotated CropBox coordinates (origin bottom-left) to Poppler's displayed raster. */
export function imageCrop(
  rects: readonly AnnotationRect[], rotation: number, width: number, height: number,
) {
  const rotate = ((rotation % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(rotate))
    throw new StoreError("PDF 页面旋转信息无效，无法准确识别所选区域。", 422);
  const mapped = rects.map((r) => {
    if (rotate === 90) return { x: r.y, y: r.x, width: r.height, height: r.width };
    if (rotate === 180) return { x: 1 - r.x - r.width, y: r.y, width: r.width, height: r.height };
    if (rotate === 270) return { x: 1 - r.y - r.height, y: 1 - r.x - r.width, width: r.height, height: r.width };
    return { x: r.x, y: 1 - r.y - r.height, width: r.width, height: r.height };
  });
  // Small padding retains fraction bars, roots, and glyphs outside text selection boxes.
  const x = Math.max(0, Math.floor(Math.min(...mapped.map((r) => r.x)) * width) - 8);
  const y = Math.max(0, Math.floor(Math.min(...mapped.map((r) => r.y)) * height) - 8);
  const right = Math.min(width, Math.ceil(Math.max(...mapped.map((r) => r.x + r.width)) * width) + 8);
  const bottom = Math.min(height, Math.ceil(Math.max(...mapped.map((r) => r.y + r.height)) * height) + 8);
  return { x, y, width: right - x, height: bottom - y };
}

async function readPNG(file: string) {
  if ((await stat(file)).size > MAX_IMAGE_BYTES)
    throw new StoreError("PDF 页面图像过大，未发送到模型。", 422);
  const bytes = await readFile(file);
  validatePNG(bytes);
  return bytes;
}

/** Only render one exact physical page; temporary visual inputs are always removed. */
export async function renderPDFImage(input: {
  file: string; pageIndex: number; rects?: readonly AnnotationRect[]; signal?: AbortSignal;
}): Promise<{ bytes: Buffer; rotation: number; crop: ReturnType<typeof imageCrop> | null }> {
  checkCancelled(input.signal);
  const cwd = await mkdtemp(path.join(os.tmpdir(), "kb-pdf-image-"));
  const options = { timeout: 30000, maxBuffer: 1024 * 1024,
    encoding: "utf8" as const, signal: input.signal,
    env: { ...process.env, LANG: "C", LC_ALL: "C" } };
  try {
    let info: string;
    try {
      const initial = await exec(process.env.KB_PDFINFO || "pdfinfo", ["-box", input.file], options);
      const pageCount = Number(initial.stdout.match(/^Pages:\s*(\d+)/m)?.[1]);
      if (!Number.isInteger(pageCount) || pageCount < 1)
        throw new StoreError("无法读取 PDF 物理页数，未进行识别。", 422);
      if (input.pageIndex >= pageCount)
        throw new StoreError("所选物理页超出附件页数，未进行识别。", 400);
      info = input.pageIndex === 0 ? initial.stdout : (await exec(
        process.env.KB_PDFINFO || "pdfinfo",
        ["-f", String(input.pageIndex + 1), "-l", String(input.pageIndex + 1), "-box", input.file], options,
      )).stdout;
    } catch (error) {
      checkCancelled(input.signal);
      if (error instanceof StoreError) throw error;
      throw new StoreError("无法读取 PDF 页面信息，请确认 pdfinfo 可用且 PDF 未加密。", 422);
    }
    const rotation = Number(info.match(/^Page\s+(?:\d+\s+)?rot:\s*(-?\d+)/m)?.[1]);
    if (!Number.isInteger(rotation))
      throw new StoreError("无法确定 PDF 页面旋转方向，未进行识别。", 422);
    checkCancelled(input.signal);
    const page = String(input.pageIndex + 1);
    const common = ["-f", page, "-l", page, "-singlefile", "-cropbox", "-hide-annotations", "-scale-to", String(MAX_EDGE), "-png"];
    try {
      const fullPrefix = path.join(cwd, "page");
      await exec(process.env.KB_PDFTOPPM || "pdftoppm", [...common, input.file, fullPrefix], options);
      checkCancelled(input.signal);
      const full = await readPNG(`${fullPrefix}.png`);
      const dimensions = validatePNG(full);
      if (!input.rects?.length) return { bytes: full, rotation, crop: null };
      const crop = imageCrop(input.rects, rotation, dimensions.width, dimensions.height);
      const cropPrefix = path.join(cwd, "selection");
      await exec(process.env.KB_PDFTOPPM || "pdftoppm", [
        ...common, "-x", String(crop.x), "-y", String(crop.y),
        "-W", String(crop.width), "-H", String(crop.height), input.file, cropPrefix,
      ], options);
      checkCancelled(input.signal);
      return { bytes: await readPNG(`${cropPrefix}.png`), rotation, crop };
    } catch (error) {
      checkCancelled(input.signal);
      if (error instanceof StoreError) throw error;
      throw new StoreError("PDF 页面图像生成失败，请确认 pdftoppm 可用且 PDF 未加密；未改用纯文本猜测公式。", 422);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
