import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { supportedNode } from "./runtime-check.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)), require = createRequire(import.meta.url);
let errors = 0;
const report = (ok, name, detail, optional = false) => {
  console.log(`${ok ? "✓" : optional ? "○" : "✗"} ${name}：${detail}`);
  if (!ok && !optional) errors++;
};
report(supportedNode(), "Node.js", `${process.versions.node}（要求 >=22.19.0）`);
try { await import("node:sqlite"); report(true, "SQLite", "运行时可用"); }
catch { report(false, "SQLite", "不可用，请安装受支持的 Node.js"); }
for (const name of ["next", "react", "pdfjs-dist", "tsx"]) {
  try { require.resolve(`${name}/package.json`); report(true, name, "已安装"); }
  catch { report(false, name, "尚未安装，请运行 npm run setup"); }
}
const built = existsSync(path.join(root, ".next", "BUILD_ID"));
report(built, "生产构建", built ? "已构建" : "尚未构建，请运行 npm run build");
for (const [name, executable, args, capability] of [
  ["PDF 文本提取", process.env.KB_PDFTOTEXT || "pdftotext", ["-v"], "论文对话需要 Poppler 的 pdftotext"],
  ["PDF 页面信息", process.env.KB_PDFINFO || "pdfinfo", ["-v"], "公式与图像识别需要 Poppler 的 pdfinfo"],
  ["PDF 页面渲染", process.env.KB_PDFTOPPM || "pdftoppm", ["-v"], "公式与图像识别需要 Poppler 的 pdftoppm"],
  ["Codex CLI", process.env.KB_CODEX_BIN || process.env.CODEX_CLI_PATH || "codex", ["--version"], "使用 Codex 提供方时需要自行安装并登录"],
]) {
  const result = spawnSync(executable, args, { timeout: 5000, stdio: "ignore", shell: false });
  report(!result.error && result.status === 0, name, !result.error && result.status === 0 ? "已找到" : capability, true);
}
console.log("\n○ 为可选组件；不影响基础文献管理、PDF 阅读和手动笔记。\n此检查不调用 AI、不检查账户额度、不读取聊天或修改知识库。环境文件由应用启动时加载。\n详见 docs/AI-SETUP.md。");
process.exitCode = errors ? 1 : 0;
