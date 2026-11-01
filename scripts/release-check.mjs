// Inspect only Git's actual publication set, never a user's ignored data directory.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
if (!files.includes("package.json") || !files.includes("README.md")) throw new Error("请在独立发布仓库中运行，并先将准备发布的代码加入 Git。");
const unstaged = execFileSync("git", ["diff", "--name-only", "-z"], { cwd: root, encoding: "utf8" });
if (unstaged) throw new Error("还有未暂存的修改，请先 git add，再检查实际准备发布的版本。");
const problems = [];
for (const file of files) {
  if (/(^|\/)(data|node_modules|\.next(?: \d+)?|test-results|screenshots)(\/|$)/.test(file) ||
      /(^|\/)(\.env(?:\..*)?|auth\.json|credentials\.json|\.DS_Store)$/.test(file) && file !== ".env.example" ||
      /(?: \d+\.(?:ts|tsx)$|\.(?:sqlite(?:-wal|-shm)?|db|log|kb\.json\.gz)$)/.test(file) ||
      file.startsWith("public/pdf") || /reference-locator-smoke\.mjs$/.test(file)) problems.push(file);
  if (/\.pdf$/i.test(file) && file !== "tests/fixtures/reading-fixture.pdf") problems.push(file);
  const full = path.join(root, file), stat = lstatSync(full);
  if (stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) problems.push(file);
  if (/\.md$/.test(file)) {
    const body = readFileSync(full, "utf8");
    if (/\/Users\/[^\s/]+\/|\/var\/folders\//.test(body)) problems.push(file + " (本机路径)");
    for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split(/[?#]/)[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) continue;
      try { lstatSync(path.resolve(path.dirname(full), decodeURIComponent(target))); }
      catch { problems.push(file + " (无效本地链接)"); }
    }
  }
}
if (problems.length) { console.error("发布文件检查失败：\n" + [...new Set(problems)].join("\n")); process.exitCode = 1; }
else console.log(`发布文件检查通过：${files.length} 个受版本管理的文件；未包含个人资料目录、凭据文件、生成缓存或真实论文附件。`);
