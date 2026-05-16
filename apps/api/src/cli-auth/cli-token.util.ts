import crypto from "crypto";

const TOKEN_PREFIX = "wv_cli_";
const SECRET_BYTES = 32;
const CODE_BYTES = 18;

export const CLI_AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Mint a fresh CLI bearer token + the sha256 hash we persist. */
export function generateCliToken(): { secret: string; hash: string } {
  const secret =
    TOKEN_PREFIX + crypto.randomBytes(SECRET_BYTES).toString("base64url");
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  return { secret, hash };
}

/** URL-safe random shown in the /cli-auth/<code> consent URL. */
export function generateCliAuthCode(): string {
  return crypto.randomBytes(CODE_BYTES).toString("base64url");
}

export function hashCliToken(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

export const CLI_TOKEN_PREFIX = TOKEN_PREFIX;
