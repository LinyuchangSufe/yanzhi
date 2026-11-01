// Webpack's compiler cache is rebuildable; the production runtime lives outside it.
// Run only after a successful production build. No papers or library data are read.
import fs from "node:fs/promises";
import path from "node:path";

const build = path.resolve(".next");
await fs.access(path.join(build, "BUILD_ID"));
const cache = path.join(build, "cache", "webpack");
const stat = await fs.lstat(cache).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (stat) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Refusing an unexpected compiler cache path");
  await fs.rm(cache, { recursive: true });
}
