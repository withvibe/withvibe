/**
 * Self-check for Anthropic key classification. This repo has no test runner,
 * so (matching check:saas-mode) this is a ts-node script:
 *
 *   pnpm --filter @withvibe/api check:anthropic-key
 *
 * Only the pure half is covered here — `verifyAnthropicKey` talks to Anthropic
 * and cannot be asserted without a real key. What it decides first, though, is
 * everything: an `sk-ant-oat*` token has to go out as a bearer with the OAuth
 * beta header and anything else as `x-api-key`, and getting that backwards
 * produces "invalid x-api-key" for a perfectly good subscription token — an
 * error that sends you looking at the key instead of at the request.
 *
 * Exits non-zero on any unexpected outcome.
 */
import { classifyAnthropicKey, AnthropicKeyError } from "./anthropic-key";

let pass = 0;
let fail = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function classify(key: string): { kind?: string; error?: string } {
  try {
    return { kind: classifyAnthropicKey(key) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

expect(
  "a Console key is an api key",
  classify("sk-ant-api03-abcdefghij").kind === "api"
);
expect(
  "a subscription token is an oauth token",
  classify("sk-ant-oat01-abcdefghij").kind === "oauth"
);
expect(
  "an unknown sk-ant- variant is treated as an api key, not rejected",
  // Anthropic has shipped more than one api prefix; refusing anything we have
  // not seen before would block a working key on our own guesswork.
  classify("sk-ant-something-new-xyz").kind === "api"
);
expect(
  "surrounding whitespace from a paste does not change the verdict",
  classify("  sk-ant-oat01-abc  ").kind === "oauth"
);

// The mistake that actually happened: a 92-character token from another
// service pasted into the field and stored without complaint, failing later as
// an opaque chat error.
{
  const r = classify("KYCG9LY7hGeSexampleexampleexampleexampleexample");
  expect("a token from another service is refused", r.kind === undefined);
  expect(
    "and the message says what an Anthropic key looks like",
    Boolean(r.error?.includes("sk-ant-api") && r.error?.includes("sk-ant-oat")),
    r.error
  );
  expect(
    "and where to get one",
    Boolean(r.error?.includes("console.anthropic.com")),
    r.error
  );
}

for (const bad of ["", "   ", "sk-", "sk-ant", "SK-ANT-API03-upper"]) {
  const r = classify(bad);
  expect(
    `refused: ${JSON.stringify(bad)}`,
    r.kind === undefined,
    `classified as ${r.kind}`
  );
}

expect(
  "the refusal is the typed error, so callers can tell it apart",
  (() => {
    try {
      classifyAnthropicKey("nope");
      return false;
    } catch (err) {
      return err instanceof AnthropicKeyError;
    }
  })()
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
