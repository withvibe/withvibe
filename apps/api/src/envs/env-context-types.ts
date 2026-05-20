import { BadRequestException } from "@nestjs/common";

export const ENV_CONTEXT_SUBDIR = "extracontext";

export const MAX_ENV_CONTEXT_ATTACHMENTS = 50;
export const MAX_ENV_CONTEXT_FILES = 5000;
export const MAX_ENV_CONTEXT_PATH_LENGTH = 600;
export const MAX_ENV_CONTEXT_NAME_LENGTH = 80;
export const MAX_ENV_CONTEXT_FILE_BYTES = 100 * 1024 * 1024; // 100 MB / file
export const MAX_ENV_CONTEXT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB / env
// Cap on what the in-app Monaco editor will load. Past this, the editor
// gets sluggish and the JSON payload over the wire starts to hurt. Users
// can still open the file in the VS Code tunnel for bigger files.
export const MAX_ENV_CONTEXT_EDITABLE_BYTES = 5 * 1024 * 1024; // 5 MB

export type EnvContextFileMeta = {
  path: string;
  size: number;
  updatedAt: string;
};

export type EnvContextAttachmentKind = "folder" | "file";

export type EnvContextAttachment = {
  id: string;
  name: string;
  kind: EnvContextAttachmentKind;
  files: EnvContextFileMeta[];
  totalBytes: number;
  createdAt: string;
  updatedAt: string;
};

export function normalizeContextName(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_ENV_CONTEXT_NAME_LENGTH ||
    !/^[A-Za-z0-9._\- ]+$/.test(trimmed) ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    throw new BadRequestException(`Invalid context attachment name: "${raw}"`);
  }
  return trimmed.replace(/\s+/g, "-");
}

export function normalizeContextRelPath(p: string): string {
  const normalized = p.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (
    normalized.length === 0 ||
    normalized.length > MAX_ENV_CONTEXT_PATH_LENGTH
  ) {
    throw new BadRequestException(`Invalid context path: "${p}"`);
  }
  const segs = normalized.split("/");
  if (segs.some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new BadRequestException(`Invalid context path: "${p}"`);
  }
  return normalized;
}
