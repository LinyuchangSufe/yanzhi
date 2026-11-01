import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// Local asset vendoring follows Papernook scripts/build-offline.mjs (MIT).
const pdfRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
await fs.mkdir("public/pdf", { recursive: true });
await fs.copyFile(
  path.join(pdfRoot, "build/pdf.worker.mjs"),
  "public/pdf/pdf.worker.mjs",
);
await fs.copyFile(path.join(pdfRoot, "LICENSE"), "public/pdf/LICENSE");
for (const dir of ["cmaps", "standard_fonts", "wasm"]) {
  await fs.cp(path.join(pdfRoot, dir), path.join("public/pdf", dir), {
    recursive: true,
  });
}
