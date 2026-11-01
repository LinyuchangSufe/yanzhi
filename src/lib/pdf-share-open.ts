import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { PDFShareResult } from "./pdf-share";

export interface FolderOpenCommand {
  command: string;
  args: string[];
}
export type FolderCommandRunner = (command: string, args: readonly string[]) => Promise<void>;

/** Only fixed programs and an already validated sharing directory are accepted. */
export function folderOpenCommand(directory: string, platform: NodeJS.Platform, revealPath?: string): FolderOpenCommand | null {
  if (platform === "darwin") return { command: "/usr/bin/open", args: revealPath ? ["-R", revealPath] : [directory] };
  if (platform === "win32") return { command: "explorer.exe", args: [directory] };
  if (platform === "linux") return { command: "xdg-open", args: [directory] };
  return null;
}

const execute: FolderCommandRunner = (command, args) => new Promise((resolve, reject) => {
  execFile(command, [...args], { timeout: 8_000, windowsHide: true, maxBuffer: 16 * 1024, shell: false }, (error) => {
    if (error) reject(error);
    else resolve();
  });
});

export async function openPDFShareFolder(
  result: PDFShareResult,
  options: { platform?: NodeJS.Platform; runner?: FolderCommandRunner; reveal?: boolean } = {},
): Promise<PDFShareResult> {
  const warning = "分享副本已准备好，但未能自动打开文件夹。请复制路径，在本机文件管理器中打开。";
  try {
    const directory = result.directory;
    const parent = path.dirname(directory);
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || path.basename(directory) !== "papers" || path.basename(parent) !== "share" || realpathSync(directory) !== directory || lstatSync(parent).isSymbolicLink())
      throw new Error("Invalid sharing directory");
    let revealPath: string | undefined;
    if (options.reveal && result.files[0]) {
      const filename = result.files[0].path;
      const fileStat = lstatSync(filename);
      if (!path.isAbsolute(filename) || path.dirname(filename) !== directory || fileStat.isSymbolicLink() || !fileStat.isFile() || realpathSync(filename) !== filename)
        throw new Error("Invalid sharing file");
      revealPath = filename;
    }
    const command = folderOpenCommand(directory, options.platform ?? process.platform, revealPath);
    if (!command) throw new Error("Unsupported platform");
    await (options.runner ?? execute)(command.command, command.args);
    return { ...result, opened: true };
  } catch {
    return { ...result, opened: false, warning: [result.warning, warning].filter(Boolean).join(" ") };
  }
}
