import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  type LucideIcon,
} from "lucide-react";
import type { TaskReference } from "../../shared/types.ts";
import { refBasename } from "./path";

export { refBasename };

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic"]);
const CODE = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "go", "rb", "rs", "java", "kt",
  "swift", "c", "cpp", "h", "hpp", "cs",
  "php", "sh", "bash", "zsh", "lua", "scala",
  "css", "scss", "sass", "less", "html", "vue", "svelte",
]);
const JSONLIKE = new Set(["json", "jsonc", "yaml", "yml", "toml"]);
const DOC = new Set(["md", "mdx", "txt", "rst", "rtf", "pdf"]);
const VIDEO = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v"]);
const AUDIO = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac"]);
const ARCHIVE = new Set(["zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz"]);
const SHEET = new Set(["csv", "xlsx", "xls", "tsv"]);

// Extensionless build / config / scripty files. Compared case-sensitively
// against the basename so we don't accidentally match e.g. a generic
// `dockerfile.md`.
const CODE_BY_NAME = new Set([
  "Dockerfile", "Containerfile", "Makefile", "Rakefile", "Gemfile",
  "Procfile", "Brewfile", "Vagrantfile", "Jenkinsfile", "Justfile",
]);
const DOC_BY_NAME = new Set([
  "README", "LICENSE", "LICENCE", "CHANGELOG", "AUTHORS", "CONTRIBUTORS",
  "NOTICE", "COPYING",
]);

/** Pick a lucide icon component for a reference based on its extension. */
export function iconForRef(ref: Pick<TaskReference, "path" | "isDirectory">): LucideIcon {
  if (ref.isDirectory) return Folder;
  const base = refBasename(ref.path);
  if (CODE_BY_NAME.has(base)) return FileCode;
  if (DOC_BY_NAME.has(base)) return FileText;
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf(".");
  // Dotfiles (`.env`, `.gitignore`, …) have their only dot at position 0;
  // treat the whole name after that dot as the extension. If nothing maps,
  // fall back to FileCode since these are almost always config or scripts.
  const isDotfile = lower.startsWith(".") && lower.indexOf(".", 1) === -1;
  const ext = isDotfile ? lower.slice(1) : (dot > 0 ? lower.slice(dot + 1) : "");
  if (IMAGE.has(ext)) return FileImage;
  if (CODE.has(ext)) return FileCode;
  if (JSONLIKE.has(ext)) return FileJson;
  if (DOC.has(ext)) return FileText;
  if (VIDEO.has(ext)) return FileVideo;
  if (AUDIO.has(ext)) return FileAudio;
  if (ARCHIVE.has(ext)) return FileArchive;
  if (SHEET.has(ext)) return FileSpreadsheet;
  if (isDotfile) return FileCode;
  return File;
}

