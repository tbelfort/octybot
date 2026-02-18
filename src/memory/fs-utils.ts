/**
 * Shared filesystem utilities for install scripts.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "fs";
import { join, resolve } from "path";

export const OCTYBOT_ROOT = resolve(import.meta.dir, "../..");
export const SKIP_DIRS = new Set(["node_modules", ".wrangler", ".mf"]);

export function copyIfChanged(src: string, dst: string): boolean {
  if (!existsSync(src)) return false;
  if (existsSync(dst)) {
    const srcStat = statSync(src);
    const dstStat = statSync(dst);
    if (srcStat.size === dstStat.size && srcStat.mtimeMs <= dstStat.mtimeMs) return false;
  }
  mkdirSync(resolve(dst, ".."), { recursive: true });
  copyFileSync(src, dst);
  return true;
}

export function copyDirRecursive(
  srcDir: string,
  dstDir: string,
  relPrefix: string,
  copied: string[],
  skipped: string[]
) {
  if (!existsSync(srcDir)) return;
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const srcPath = join(srcDir, entry);
    const dstPath = join(dstDir, entry);
    const relPath = `${relPrefix}/${entry}`;
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, dstPath, relPath, copied, skipped);
    } else {
      if (copyIfChanged(srcPath, dstPath)) {
        copied.push(relPath);
      } else {
        skipped.push(relPath);
      }
    }
  }
}
