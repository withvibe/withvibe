import { BadRequestException } from "@nestjs/common";

// A template declares variables. The orchestrator resolves each kind at
// materialize time:
//   - system-port  → allocated by PortAllocator (per env, unique host port)
//   - user-input   → collected from the end-user on the create-env form
//   - secret       → pulled from a vault (placeholder for now — read from env var)
//   - default      → static value baked into the template
//   - service-url  → resolves to the full URL where `service` can be reached.
//                    Subdomain mode: http://<service>-<id>.<baseDomain>
//                    Port mode:      http://${PUBLIC_HOST}:${<portKey value>}
export type TemplateVariableKind =
  | "system-port"
  | "user-input"
  | "secret"
  | "default"
  | "service-url";

export type TemplateVariable = {
  key: string;                      // matches ${KEY} in compose / asset templates
  kind: TemplateVariableKind;
  label?: string;                   // shown in UI forms
  description?: string;             // help text in UI / admin
  defaultValue?: string;            // for "default" and optional "user-input"
  required?: boolean;               // only meaningful for "user-input"
  secretName?: string;              // for "secret" — name in vault / env var
  service?: string;                 // for "service-url" — docker compose service name
  portKey?: string;                 // for "service-url" — system-port var key used in port mode
};

const KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const VALID_KINDS: TemplateVariableKind[] = [
  "system-port",
  "user-input",
  "secret",
  "default",
  "service-url",
];

// Reserved variable keys the orchestrator injects automatically. Template
// authors must NOT redeclare these — the materializer would silently shadow
// their definition. Catching it at parse time is clearer.
export const RESERVED_VARIABLE_KEYS = ["PUBLIC_HOST"] as const;
export type ReservedVariableKey = (typeof RESERVED_VARIABLE_KEYS)[number];

export function parseTemplateVariables(raw: unknown): TemplateVariable[] {
  if (!Array.isArray(raw)) {
    throw new BadRequestException("variables must be an array");
  }
  const out: TemplateVariable[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") {
      throw new BadRequestException(`variables[${i}] must be an object`);
    }
    const v = item as Record<string, unknown>;
    if (typeof v.key !== "string" || !KEY_RE.test(v.key)) {
      throw new BadRequestException(
        `variables[${i}].key must be UPPER_SNAKE_CASE starting with a letter`
      );
    }
    if ((RESERVED_VARIABLE_KEYS as readonly string[]).includes(v.key)) {
      throw new BadRequestException(
        `"${v.key}" is a reserved variable injected by the orchestrator — do not declare it`
      );
    }
    if (seen.has(v.key)) {
      throw new BadRequestException(`Duplicate variable key "${v.key}"`);
    }
    seen.add(v.key);
    if (typeof v.kind !== "string" || !VALID_KINDS.includes(v.kind as TemplateVariableKind)) {
      throw new BadRequestException(
        `variables[${i}].kind must be one of ${VALID_KINDS.join(", ")}`
      );
    }
    const parsed: TemplateVariable = { key: v.key, kind: v.kind as TemplateVariableKind };
    if (typeof v.label === "string") parsed.label = v.label;
    if (typeof v.description === "string") parsed.description = v.description;
    if (typeof v.defaultValue === "string") parsed.defaultValue = v.defaultValue;
    if (typeof v.required === "boolean") parsed.required = v.required;
    if (typeof v.secretName === "string") parsed.secretName = v.secretName;
    if (typeof v.service === "string") parsed.service = v.service;
    if (typeof v.portKey === "string") parsed.portKey = v.portKey;
    // `service` is intentionally NOT required for kind=service-url: leaving
    // it blank is a valid signal that the DevOps agent should infer which
    // compose service to bind, using the variable's `description` and the
    // compose file as context.
    out.push(parsed);
  }
  return out;
}

// Describes a single service in the template's docker-compose file. All fields
// are optional enrichment the template author provides to help the DevOps
// agent (and future UI surfaces) understand the service's purpose.
export type TemplateService = {
  name: string;                     // must match a service key in composeFile
  description?: string;             // free-text purpose of the service
  role?: string;                    // free-text role tag (e.g. "frontend", "db")
  userFacing?: boolean;             // service exposes a UI humans open
  agentInstructions?: string;       // per-service guidance for the DevOps agent
};

const SERVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function parseTemplateServices(raw: unknown): TemplateService[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new BadRequestException("services must be an array");
  }
  const out: TemplateService[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") {
      throw new BadRequestException(`services[${i}] must be an object`);
    }
    const v = item as Record<string, unknown>;
    if (typeof v.name !== "string" || !SERVICE_NAME_RE.test(v.name)) {
      throw new BadRequestException(
        `services[${i}].name must match a compose service name`
      );
    }
    if (seen.has(v.name)) {
      throw new BadRequestException(`Duplicate service "${v.name}"`);
    }
    seen.add(v.name);
    const parsed: TemplateService = { name: v.name };
    if (typeof v.description === "string" && v.description.trim())
      parsed.description = v.description;
    if (typeof v.role === "string" && v.role.trim()) parsed.role = v.role;
    if (typeof v.userFacing === "boolean") parsed.userFacing = v.userFacing;
    if (typeof v.agentInstructions === "string" && v.agentInstructions.trim())
      parsed.agentInstructions = v.agentInstructions;
    out.push(parsed);
  }
  return out;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function normalizeTemplateSlug(raw: unknown): string {
  if (typeof raw !== "string" || !SLUG_RE.test(raw)) {
    throw new BadRequestException(
      "slug must be lowercase alphanumerics/hyphens, max 64 chars"
    );
  }
  return raw;
}

const MAX_TEMPLATE_ASSET_PATH_LENGTH = 400;

// Same rules as env assets: no leading slash, no ".." traversal, no reserved
// prefix. The materializer will also reject any path not matched here.
export function normalizeTemplateAssetPath(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new BadRequestException("asset path must be a string");
  }
  const normalized = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.length === 0 || normalized.length > MAX_TEMPLATE_ASSET_PATH_LENGTH) {
    throw new BadRequestException(`Invalid asset path: "${raw}"`);
  }
  const segs = normalized.split("/");
  if (
    segs.some((seg) => seg === "" || seg === "." || seg === "..") ||
    normalized.startsWith(".withvibe-")
  ) {
    throw new BadRequestException(`Invalid asset path: "${raw}"`);
  }
  return normalized;
}
