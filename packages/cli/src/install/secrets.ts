import crypto from "node:crypto";

export function randomSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function randomPassword(bytes = 24): string {
  // base64url is shell-safe and slightly shorter than hex.
  return crypto.randomBytes(bytes).toString("base64url");
}
