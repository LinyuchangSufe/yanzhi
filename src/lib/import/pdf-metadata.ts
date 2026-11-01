import type { PDFDocumentLoadingTask } from "pdfjs-dist";

export interface PdfImportMetadata {
  title?: string;
  authors?: string[];
  year?: number;
  doi?: string;
  arxivId?: string;
  arxivVersion?: number | null;
}
export type PdfMetadataField = "title" | "authors" | "year" | "doi" | "arxivId";
export interface PdfMetadataResult {
  metadata: PdfImportMetadata;
  sources: Partial<Record<PdfMetadataField, string>>;
  warnings: string[];
}
export interface PdfMetadataTextItem {
  str: string;
  transform: readonly number[];
  width: number;
  height: number;
}
export interface PdfMetadataInput {
  filename: string;
  info?: Record<string, unknown>;
  xmp?: Record<string, unknown>;
  items: PdfMetadataTextItem[];
  pageView: readonly number[];
}
interface Line {
  text: string;
  y: number;
  size: number;
  runs: PdfMetadataTextItem[];
}

function plain(value: unknown): string {
  const string = Array.isArray(value)
    ? value.filter((item) => typeof item === "string").join("; ")
    : typeof value === "string"
      ? value
      : "";
  return string
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function usefulTitle(value: unknown): string | undefined {
  const title = plain(value);
  if (title.length < 4 || title.length > 600 || !/\p{L}{2}/u.test(title))
    return;
  if (
    /^(?:untitled|unknown|no title|title|document|article|paper|manuscript|main|output|submission)(?:[\s_.-]*(?:final|draft|v\d+|\d+))*$/i.test(
      title,
    )
  )
    return;
  if (
    /(?:microsoft\s+(?:word|powerpoint)|adobe\s+acrobat|libreoffice|latex\s+(?:document|output)|pdftex|pdflatex|ghostscript|acrobat distiller|^tex$|^\w+\.tex$|^\w+\.dvi$|^\w+\.docx?$)/i.test(
      title,
    )
  )
    return;
  if (
    /[\\/]?(?:users|home|documents)[\\/]|\\(?:documentclass|begin|title)\b/i.test(
      title,
    )
  )
    return;
  return title;
}

const affiliation =
  /(?:university|institute|laborator|department|school|college|corporation|research|microsoft|google|openai|\binc\b|\bllc\b|\bltd\b|@|\.edu\b|\.com\b|abstract|introduction|received|published|keywords|orcid|correspond|contribution|版权|大学|学院|实验室|研究所)/i;

function authorNames(value: unknown): string[] | undefined {
  const author = plain(value);
  if (
    !author ||
    author.length > 1500 ||
    affiliation.test(author) ||
    /(?:adobe|acrobat|pdftex|pdflatex|ghostscript|libreoffice)/i.test(author) ||
    /^(?:unknown|anonymous|author|authors|admin|user|owner|latex|administrator|test)$/i.test(
      author,
    )
  )
    return;
  let parts = author.split(/\s*(?:;|\band\b|&|、|\n)\s*/i);
  if (parts.length === 1 && author.includes(",")) {
    const comma = author.split(/\s*,\s*/);
    if (
      comma.every(
        (part) => /\s/.test(part) || /^[\p{Script=Han}]{2,5}$/u.test(part),
      )
    )
      parts = comma;
  }
  const names = parts
    .map((part) => part.replace(/[\s\d*†‡∗]+$/gu, "").trim())
    .filter(
      (part) =>
        part.length > 1 &&
        part.length < 120 &&
        /\p{L}/u.test(part) &&
        !affiliation.test(part),
    );
  return names.length ? [...new Set(names)].slice(0, 50) : undefined;
}

function sizeOf(item: PdfMetadataTextItem): number {
  return (
    Math.abs(item.height) ||
    Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0)
  );
}

function joinRuns(runs: PdfMetadataTextItem[]): string {
  let result = "";
  let previous: PdfMetadataTextItem | undefined;
  for (const run of runs) {
    const gap = previous
      ? run.transform[4] - previous.transform[4] - previous.width
      : 0;
    if (
      previous &&
      gap > Math.min(sizeOf(previous), sizeOf(run)) * 0.19 &&
      !/\s$/.test(result) &&
      !/^\s/.test(run.str)
    )
      result += " ";
    result += run.str;
    previous = run;
  }
  return plain(result);
}

function layoutLines(items: PdfMetadataTextItem[]): Line[] {
  const lines: Line[] = [];
  const horizontal = items.filter(
    (item) =>
      item.str &&
      item.transform.length >= 6 &&
      item.transform.every(Number.isFinite) &&
      Math.abs(item.transform[1]) <
        Math.max(0.01, Math.abs(item.transform[0]) * 0.3) &&
      !/^[\d*†‡∗]+$/u.test(item.str.trim()),
  );
  horizontal.sort(
    (left, right) =>
      right.transform[5] - left.transform[5] ||
      left.transform[4] - right.transform[4],
  );
  for (const item of horizontal) {
    const y = item.transform[5];
    const existing = lines.find(
      (line) =>
        Math.abs(line.y - y) <= Math.min(2.5, Math.max(1, sizeOf(item) * 0.16)),
    );
    if (existing) existing.runs.push(item);
    else lines.push({ y, size: sizeOf(item), text: "", runs: [item] });
  }
  for (const line of lines) {
    line.runs.sort((left, right) => left.transform[4] - right.transform[4]);
    line.text = joinRuns(line.runs);
    const meaningful = line.runs.filter((run) => run.str.trim());
    const weight =
      meaningful.reduce((sum, run) => sum + run.str.length, 0) || 1;
    line.size =
      meaningful.reduce((sum, run) => sum + sizeOf(run) * run.str.length, 0) /
      weight;
  }
  return lines
    .filter((line) => line.text)
    .sort((left, right) => right.y - left.y);
}

function layoutTitle(
  lines: Line[],
  pageView: readonly number[],
): { title: string; end: number } | undefined {
  const top = pageView[3];
  const height = top - pageView[1];
  const abstract = lines.findIndex((line) =>
    /^(?:abstract|摘要|1\s+introduction)\b/i.test(line.text),
  );
  const candidates = lines.filter(
    (line, index) =>
      (abstract < 0 || index < abstract) &&
      (top - line.y) / height > 0.025 &&
      (top - line.y) / height < 0.48 &&
      line.text.length >= 8 &&
      line.text.length < 280 &&
      !/^(?:arxiv|preprint|proceedings|submitted|accepted|published|copyright|journal|conference|volume|vol\.|doi\b|https?:)/i.test(
        line.text,
      ) &&
      usefulTitle(line.text),
  );
  if (!candidates.length) return;
  const maximum = Math.max(...candidates.map((line) => line.size));
  const sizes = lines
    .flatMap((line) =>
      line.runs.filter((run) => run.str.trim().length > 3).map(sizeOf),
    )
    .sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] ?? maximum;
  if (maximum < median * 1.12) return;
  const first = candidates.find((line) => line.size >= maximum * 0.9);
  if (!first) return;
  const start = lines.indexOf(first);
  const titleLines = [first.text];
  let end = start;
  for (
    let index = start + 1;
    index < Math.min(lines.length, start + 5);
    index++
  ) {
    const line = lines[index];
    if (
      lines[index - 1].y - line.y > maximum * 1.85 ||
      line.size < maximum * 0.85 ||
      !usefulTitle(line.text) ||
      affiliation.test(line.text)
    )
      break;
    titleLines.push(line.text);
    end = index;
  }
  const title = titleLines
    .join("\n")
    .replace(/([A-Z]{3,})-\n([A-Z])/g, "$1$2")
    .replace(/\n/g, " ");
  return usefulTitle(title) ? { title, end } : undefined;
}

function layoutAuthors(lines: Line[], titleEnd: number): string[] | undefined {
  const title = lines[titleEnd];
  const authors: string[] = [];
  for (const line of lines.slice(titleEnd + 1, titleEnd + 4)) {
    if (
      title.y - line.y > 105 ||
      line.size > title.size * 0.94 ||
      affiliation.test(line.text) ||
      /[=:{}<>]/.test(line.text)
    )
      break;
    const chunks: string[] = [];
    let current: PdfMetadataTextItem[] = [];
    for (const run of line.runs) {
      const previous = current.at(-1);
      const gap = previous
        ? run.transform[4] - previous.transform[4] - previous.width
        : 0;
      if (
        (run.str.trim() === "" && run.width > line.size * 1.3) ||
        gap > line.size * 1.3
      ) {
        if (current.length) chunks.push(joinRuns(current));
        current = [];
        if (!run.str.trim()) continue;
      }
      current.push(run);
    }
    if (current.length) chunks.push(joinRuns(current));
    const names = chunks
      .flatMap((chunk) => authorNames(chunk) ?? [])
      .filter(
        (name) =>
          /^[\p{Script=Han}]{2,5}$/u.test(name) ||
          /^(?:[A-ZÀ-ÖØ-Þ][\p{L}’'.-]*|[A-Z]\.)(?:\s+(?:[A-ZÀ-ÖØ-Þ][\p{L}’'.-]*|[A-Z]\.|de|van|von|da|del)){1,5}$/u.test(
            name,
          ),
      );
    if (!names.length) break;
    authors.push(...names);
  }
  return authors.length ? [...new Set(authors)] : undefined;
}

function validYear(value: unknown): number | undefined {
  const year = Number(
    plain(value).match(/^(?:D:)?((?:18|19|20)\d{2})(?=[^\d]|$|\d{2})/)?.[1],
  );
  return Number.isInteger(year) &&
    year >= 1800 &&
    year <= new Date().getFullYear() + 1
    ? year
    : undefined;
}

function filenameTitle(filename: string): string | undefined {
  const name = filename
    .replace(/\.pdf$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s*[-–—]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return usefulTitle(name);
}

function doiCandidates(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/\b10\.\d{4,9}\/[-._;()/:a-z0-9]+/gi)].map((match) => {
        let cleaned = match[0].replace(/[.,;]+$/, "");
        while (
          cleaned.endsWith(")") &&
          (cleaned.match(/\)/g)?.length ?? 0) >
            (cleaned.match(/\(/g)?.length ?? 0)
        )
          cleaned = cleaned.slice(0, -1);
        return cleaned.toLowerCase();
      }),
    ),
  ];
}

/** Pure extraction. Every layout/filename inference is labelled as a candidate. */
export function parsePdfMetadata(input: PdfMetadataInput): PdfMetadataResult {
  const result: PdfMetadataResult = { metadata: {}, sources: {}, warnings: [] };
  const { metadata, sources, warnings } = result;
  const info = input.info ?? {};
  const xmp = input.xmp ?? {};
  const lines = layoutLines(input.items);
  const text = lines.map((line) => line.text).join("\n");
  // Identifiers can run vertically along a page edge (including arXiv's stamp).
  // Their detection must not share the horizontal-only title layout filter.
  const allText = input.items.map((item) => item.str).join(" ");
  const titleLayout = layoutTitle(lines, input.pageView);
  const infoTitle = usefulTitle(info.Title);
  const normalizedTitle = (value: string) =>
    value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const basename = input.filename.replace(/\.pdf$/i, "").trim();
  const copiedFilename = !!(
    infoTitle &&
    titleLayout &&
    normalizedTitle(infoTitle) === normalizedTitle(basename) &&
    normalizedTitle(infoTitle) !== normalizedTitle(titleLayout.title)
  );
  const title =
    (copiedFilename ? undefined : infoTitle) ?? usefulTitle(xmp["dc:title"]);
  if (copiedFilename)
    warnings.push(
      "PDF 内嵌标题只是文件名副本；已优先使用首页排版中的候选标题，请核对。",
    );
  if (title) {
    metadata.title = title;
    sources.title =
      infoTitle && !copiedFilename
        ? "PDF 内嵌 Title（请核对）"
        : "PDF XMP dc:title（请核对）";
  } else if (titleLayout) {
    metadata.title = titleLayout.title;
    sources.title = "首页字体与布局推断（候选标题）";
    warnings.push("标题由首页排版推断，请核对；未调用在线服务。");
  } else {
    metadata.title = filenameTitle(input.filename);
    if (metadata.title) {
      sources.title = "文件名清理（候选标题）";
      warnings.push("没有可靠的 PDF 标题，暂用文件名，请手工核对。");
    }
  }
  const authors = authorNames(info.Author) ?? authorNames(xmp["dc:creator"]);
  if (authors) {
    metadata.authors = authors;
    sources.authors = authorNames(info.Author)
      ? "PDF 内嵌 Author（请核对）"
      : "PDF XMP dc:creator（请核对）";
  } else if (titleLayout) {
    const guessed = layoutAuthors(lines, titleLayout.end);
    if (guessed) {
      metadata.authors = guessed;
      sources.authors = "首页标题下方姓名布局推断（候选作者）";
      warnings.push("作者由首页姓名布局推断，可能不完整，请核对。");
    }
  }
  const embeddedDois = doiCandidates(
    `${plain(xmp["prism:doi"])} ${plain(xmp["dc:identifier"])}`,
  );
  const dois = doiCandidates(allText);
  if (embeddedDois.length === 1) {
    metadata.doi = embeddedDois[0];
    sources.doi = "PDF XMP DOI（尚未联网核验）";
  } else if (dois.length === 1) {
    metadata.doi = dois[0];
    sources.doi = "首页唯一 DOI 字符串（尚未联网核验）";
  } else if (dois.length > 1 || embeddedDois.length > 1)
    warnings.push(
      "首页或嵌入信息包含多个不同 DOI，可能来自引用文献；没有自动选择，请手工核对。",
    );
  const arxivMatches = [
    ...allText.matchAll(
      /(?:arxiv\s*:\s*|(?:https?:\/\/)?(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})(?:v(\d+))?/gi,
    ),
  ];
  const arxivIds = [
    ...new Set(arxivMatches.map((match) => match[1].toLowerCase())),
  ];
  const arxiv = arxivIds.length === 1 ? arxivMatches[0] : undefined;
  if (arxiv) {
    metadata.arxivId = arxiv[1];
    metadata.arxivVersion = arxiv[2] ? Number(arxiv[2]) : null;
    sources.arxivId = "首页唯一 arXiv 标识（尚未联网核验）";
  } else if (arxivIds.length > 1)
    warnings.push(
      "首页包含多个不同 arXiv 标识，可能来自引用文献；没有自动选择，请手工核对。",
    );
  const explicit = text.match(
    /(?:^|\n)\s*(?:published(?:\s+online)?|publication(?:\s+date|\s+year)?|date\s+of\s+publication|出版(?:年|日期)|发表(?:日期|年份)?)\s*[:：]?\s*(?:\d{1,2}\s+[a-z]+\s+)?((?:18|19|20)\d{2})\b/i,
  );
  const xmpYear = validYear(xmp["prism:publicationDate"]);
  const fileYears = [
    ...input.filename.matchAll(
      /(?:^|[\s_.()[\]-])((?:18|19|20)\d{2})(?=$|[\s_.()[\]-])/g,
    ),
  ]
    .map((match) => validYear(match[1]))
    .filter((year): year is number => !!year);
  if (xmpYear) {
    metadata.year = xmpYear;
    sources.year = "PDF XMP prism:publicationDate（请核对）";
  } else if (explicit && validYear(explicit[1])) {
    metadata.year = Number(explicit[1]);
    sources.year = "首页明确标注的发表日期（请核对）";
  } else if (arxiv && /^\d{4}\./.test(arxiv[1])) {
    const shortYear = Number(arxiv[1].slice(0, 2));
    const year = shortYear >= 91 ? 1900 + shortYear : 2000 + shortYear;
    if (validYear(String(year))) {
      metadata.year = year;
      sources.year = "arXiv 标识对应的预印本年份（不是正式出版年）";
      warnings.push("年份来自 arXiv 预印本标识，不等同正式出版年。");
    }
  }
  if (!metadata.year && new Set(fileYears).size === 1) {
    metadata.year = fileYears[0];
    sources.year = "文件名中的独立年份（候选年份，非确认出版年）";
    warnings.push("年份来自文件名，仅为候选，不代表已经确认出版日期。");
  }
  const creationYear = validYear(info.CreationDate);
  if (creationYear && !metadata.year)
    warnings.push(
      `PDF 文件创建于 ${creationYear} 年；创建日期不等于论文出版日期，因此没有自动填写年份。`,
    );
  if (!metadata.title)
    warnings.push("未识别到可用标题，请手工填写；文献仍可保存。");
  if (!input.items.some((item) => /\p{L}/u.test(item.str)))
    warnings.push("首页没有可提取文字，可能是扫描件；本版本不进行 OCR。");
  result.warnings = [...new Set(warnings)];
  return result;
}

/** Browser-only, local PDF metadata inspection; no uploads, fetches or saves. */
export async function inspectPdfFile(file: File): Promise<PdfMetadataResult> {
  if (typeof window === "undefined")
    throw new Error("PDF 本地识别需要在浏览器中运行。");
  if (!file.size)
    throw new Error("PDF 文件为空，请选择有效附件或手工填写信息。");
  if (file.size > 100 * 1024 * 1024)
    throw new Error("PDF 超过 100 MiB，暂不自动识别；可手工填写信息。");
  let task: PDFDocumentLoadingTask | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Error(
    "PDF 识别超过 18 秒，已停止；可以手工填写信息后保存。",
  );
  const work = async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdfjs = await import("pdfjs-dist");
    if (finished) throw timedOut;
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf/pdf.worker.mjs";
    const options = {
      data: bytes,
      isEvalSupported: false,
      cMapUrl: "/pdf/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdf/standard_fonts/",
      wasmUrl: "/pdf/wasm/",
      useSystemFonts: true,
    };
    task = pdfjs.getDocument(options);
    const document = await task.promise;
    if (finished) throw timedOut;
    const embedded = await document.getMetadata().catch(() => null);
    const page = await document.getPage(1);
    const text = await page.getTextContent();
    if (finished) throw timedOut;
    const xmp = embedded?.metadata
      ? Object.fromEntries(
          embedded.metadata as unknown as Iterable<[string, unknown]>,
        )
      : undefined;
    return parsePdfMetadata({
      filename: file.name,
      info: embedded?.info as Record<string, unknown> | undefined,
      xmp,
      pageView: page.view,
      items: text.items.flatMap((item) =>
        "str" in item
          ? [
              {
                str: item.str,
                transform: item.transform,
                width: item.width,
                height: item.height,
              },
            ]
          : [],
      ),
    });
  };
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          finished = true;
          reject(timedOut);
        }, 18_000);
      }),
    ]);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "PasswordException")
      throw new Error(
        "PDF 已加密并需要密码，暂不能自动识别；可以手工填写文献信息。",
      );
    if (error === timedOut) throw timedOut;
    if (
      error instanceof Error &&
      /invalid|missing|unexpected response|format|pdf/i.test(
        `${error.name} ${error.message}`,
      )
    )
      throw new Error(
        "PDF 损坏或格式无法解析；可以手工填写文献信息并选择其他附件。",
      );
    throw new Error("无法读取 PDF 元数据；可以手工填写文献信息。", {
      cause: error,
    });
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
    void task?.destroy().catch(() => {});
  }
}
