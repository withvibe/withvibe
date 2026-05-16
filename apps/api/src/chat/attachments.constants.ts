// Hard limits for chat-message attachments. Mirrors the env-asset pattern but
// scoped per-message: a single send carries up to 10 files, 25 MB each.
export const MAX_ATTACHMENT_FILES = 10;
export const MAX_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

// MIME whitelist. We block everything else at the controller boundary so we
// never write unexpected binaries into the env's working tree.
export const ATTACHMENT_MIME_WHITELIST: ReadonlySet<string> = new Set([
  // images
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  // documents
  "application/pdf",
  // text & code
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/css",
  "text/javascript",
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
]);

// Some OSes/browsers send `text/x-…` for source files (e.g. text/x-python).
// Accept that whole prefix family rather than enumerating every language.
export function isAllowedMime(mime: string): boolean {
  if (ATTACHMENT_MIME_WHITELIST.has(mime)) return true;
  if (mime.startsWith("text/x-")) return true;
  return false;
}

// Sanitize an upload filename so it's safe to drop on disk inside the env's
// working tree. Strips path separators, hidden-file dots, and clamps length.
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base
    .replace(/[^A-Za-z0-9._\- ]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  const final = cleaned.length > 0 ? cleaned : "file";
  return final.length > 120 ? final.slice(0, 120) : final;
}
