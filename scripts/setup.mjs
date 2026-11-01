import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireSupportedNode } from "./runtime-check.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
async function npm(args) {
  const entry = process.env.npm_execpath;
  if (!entry) throw new Error("请使用 npm run setup 启动安装。");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
    const interrupt = () => child.kill("SIGINT");
    process.once("SIGINT", interrupt);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", interrupt);
      if (code === 0) resolve(); else reject(new Error(`npm ${args.join(" ")} 未完成（${signal || code}）。修复上方错误后重试。`));
    });
  });
}
try {
  requireSupportedNode();
  console.log("研知：安装锁定依赖并构建；不会导入或修改知识库。\n");
  await npm(["ci"]);
  await npm(["run", "build"]);
  console.log("\n安装完成。运行 npm run doctor 检查可选组件，运行 npm start 启动。\n打开 http://127.0.0.1:3000 。");
} catch (error) {
  console.error(error instanceof Error ? error.message : "安装失败，请检查上方输出。");
  process.exitCode = 1;
}
