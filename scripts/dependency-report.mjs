import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Offline metadata inventory. This script neither installs nor executes packages.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const manifestText = read("package.json");
const lockText = read("package-lock.json");
const manifest = JSON.parse(manifestText);
const lock = JSON.parse(lockText);
const directRuntime = manifest.dependencies ?? {};
const directDevelopment = manifest.devDependencies ?? {};
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const histogram = (items, field) =>
  Object.fromEntries(
    [...new Set(items.map((entry) => entry[field]))]
      .sort(order)
      .map((key) => [
        key,
        items.filter((entry) => entry[field] === key).length,
      ]),
  );
const packages = Object.entries(lock.packages ?? {})
  .filter(([location]) => location)
  .map(([location, value]) => {
    const name = value.name ?? location.split("node_modules/").at(-1);
    const installedFile = path.join(root, location, "package.json");
    const installed = fs.existsSync(installedFile);
    const local = installed
      ? JSON.parse(fs.readFileSync(installedFile, "utf8"))
      : undefined;
    const lifecycle = Object.fromEntries(
      Object.entries(local?.scripts ?? {}).filter(([name]) =>
        ["preinstall", "install", "postinstall"].includes(name),
      ),
    );
    const rootNotices = installed
      ? fs
          .readdirSync(path.join(root, location))
          .filter((filename) =>
            /^(licen[cs]e|copying|notice)(?:$|[._-])/i.test(filename),
          )
          .flatMap((filename) => {
            const relative = `${location}/${filename}`;
            if (!fs.statSync(path.join(root, relative)).isFile()) return [];
            return [
              {
                path: relative,
                sha256: sha(fs.readFileSync(path.join(root, relative))),
              },
            ];
          })
      : [];
    return {
      location,
      name,
      version: value.version ?? null,
      license: value.license ?? "UNKNOWN",
      scope: value.dev === true ? "development-only" : "runtime-capable",
      direct: Object.hasOwn(directRuntime, name)
        ? "runtime"
        : Object.hasOwn(directDevelopment, name)
          ? "development"
          : null,
      optional: value.optional === true,
      installed,
      installedVersion: local?.version ?? null,
      resolved: value.resolved ?? null,
      integrity: value.integrity ?? null,
      engines: value.engines ?? null,
      os: value.os ?? null,
      cpu: value.cpu ?? null,
      hasInstallScript: value.hasInstallScript === true,
      installedLifecycleScripts: lifecycle,
      rootNotices,
    };
  })
  .sort((a, b) => order(a.location, b.location));

const supplementalSources = [
  [
    "node_modules/@img/sharp-libvips-darwin-arm64/README.md",
    "Installed binary's upstream license matrix includes LGPLv3, cairo MPL-1.1, BSD-like and other notices; this is not a full source offer.",
  ],
  [
    "node_modules/next/dist/compiled/@vercel/og/LICENSE",
    "MPL-2.0 text bundled inside the Next package, absent from lock-level Next MIT metadata.",
  ],
  [
    "node_modules/next/dist/compiled/@vercel/og/satori/LICENSE",
    "MPL-2.0 text bundled inside Next; retain applicable upstream notices when distributing these files.",
  ],
  [
    "node_modules/pdfjs-dist/cmaps/LICENSE",
    "Adobe CMap notice; copied with CMap assets by scripts/assets.mjs.",
  ],
  [
    "node_modules/pdfjs-dist/standard_fonts/LICENSE_FOXIT",
    "Foxit font permissive notice; copied with standard fonts.",
  ],
  [
    "node_modules/pdfjs-dist/standard_fonts/LICENSE_LIBERATION",
    "GPL v2 text with upstream font-specific exceptions; the PDF.js package Apache-2.0 label does not replace it.",
  ],
  [
    "node_modules/pdfjs-dist/wasm/LICENSE_OPENJPEG",
    "OpenJPEG BSD notice; copied with WebAssembly assets.",
  ],
  [
    "node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_OPENJPEG",
    "PDF.js OpenJPEG glue notice; copied with WebAssembly assets.",
  ],
  [
    "node_modules/pdfjs-dist/wasm/LICENSE_QCMS",
    "QCMS MIT-style notice; copied with WebAssembly assets.",
  ],
  [
    "node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_QCMS",
    "PDF.js QCMS glue MIT notice; copied with WebAssembly assets.",
  ],
  [
    "node_modules/pdfjs-dist/wasm/LICENSE_JBIG2",
    "JBIG2 permissive notice; copied with WebAssembly assets.",
  ],
  [
    "node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_JBIG2",
    "PDF.js JBIG2 glue Apache-2.0 notice; copied with WebAssembly assets.",
  ],
  [
    "node_modules/pdfjs-dist/iccs/LICENSE",
    "CC0-1.0 color-profile notice; this directory is not copied by the current asset script.",
  ],
];
const supplementalNotices = supplementalSources.map(([relative, note]) => ({
  path: relative,
  available: fs.existsSync(path.join(root, relative)),
  note,
  sha256: fs.existsSync(path.join(root, relative))
    ? sha(fs.readFileSync(path.join(root, relative)))
    : null,
}));
const absentCandidates = [
  "tldraw",
  "openai",
  "@anthropic-ai/sdk",
  "@openai/codex-sdk",
  "better-sqlite3",
];
const report = {
  format: "personal-research-kb-offline-dependency-inventory",
  version: 1,
  sources: {
    packageJson: "package.json",
    packageLock: "package-lock.json",
    packageJsonSha256: sha(manifestText),
    packageLockSha256: sha(lockText),
    lockfileVersion: lock.lockfileVersion,
  },
  method:
    "Lockfile license metadata plus installed root notice paths/hashes and specifically inspected bundled notices. No network, install, lifecycle execution or vulnerability-database query.",
  limitations: [
    "An npm license field is upstream metadata, not a legal clearance or a guarantee that bundled native code, fonts and data all use that license.",
    "Runtime-capable means not marked dev-only in the lock; optional packages include other operating systems and need not be installed or loaded here.",
    "Installed notices depend on the local node_modules contents. Re-run after a clean install on every target distribution platform.",
    "No current CVE/advisory audit, complete source-code audit, artifact reachability analysis, binary composition audit or legal opinion is provided.",
    "Node builtins, Node's bundled SQLite, system pdftotext/Poppler, browsers and independently downloaded model weights are outside this npm lock inventory.",
  ],
  summary: {
    totalLockEntries: packages.length,
    runtimeCapable: packages.filter(
      (entry) => entry.scope === "runtime-capable",
    ).length,
    developmentOnly: packages.filter(
      (entry) => entry.scope === "development-only",
    ).length,
    optional: packages.filter((entry) => entry.optional).length,
    installed: packages.filter((entry) => entry.installed).length,
    licenses: histogram(packages, "license"),
    unknownLicenseEntries: packages
      .filter((entry) => entry.license === "UNKNOWN")
      .map((entry) => entry.location),
    missingIntegrityEntries: packages
      .filter((entry) => !entry.integrity)
      .map((entry) => entry.location),
    nonRegistryResolvedEntries: packages
      .filter(
        (entry) =>
          entry.resolved &&
          !entry.resolved.startsWith("https://registry.npmjs.org/"),
      )
      .map((entry) => entry.location),
    installedVersionMismatches: packages
      .filter(
        (entry) => entry.installed && entry.installedVersion !== entry.version,
      )
      .map((entry) => entry.location),
    installScriptEntries: packages
      .filter(
        (entry) =>
          entry.hasInstallScript ||
          Object.keys(entry.installedLifecycleScripts).length,
      )
      .map((entry) => entry.location),
  },
  excludedFromThisLock: absentCandidates.filter(
    (name) => !packages.some((entry) => entry.name === name),
  ),
  builtins: [
    {
      name: "node:sqlite",
      note: "DatabaseSync provided by Node; no better-sqlite3 npm native addon. Review the chosen Node distribution's LICENSE including bundled third-party notices.",
    },
  ],
  supplementalNotices,
  packages,
};
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
// Keep each package on one line; a generated inventory should stay below the repository's file-length cap.
const { packages: packageRecords, ...header } = report;
const formattedHeader = JSON.stringify(header, null, 2).replace(/\n}$/, ",\n");
fs.writeFileSync(
  path.join(root, "docs/dependency-licenses.json"),
  `${formattedHeader}  "packages": [\n${packageRecords.map((record) => `    ${JSON.stringify(record)}`).join(",\n")}\n  ]\n}\n`,
);
console.log(
  JSON.stringify(
    { output: "docs/dependency-licenses.json", ...report.summary },
    null,
    2,
  ),
);
