import { BadRequestException, Injectable } from "@nestjs/common";
import { randomBytes } from "crypto";
import type { ComputeTarget } from "@withvibe/db";
import {
  parseEnvSpec,
  EnvSpecError,
  type EnvSpec,
} from "./env-spec";
import {
  compileToCompose,
  type CompileResult,
} from "./compile-to-compose";
import { PRESET_TYPES, SERVICE_PRESETS } from "./service-presets";

/** Shape persisted in `Env.specSecrets`: service → purpose → value. */
export type SpecSecrets = Record<string, Record<string, string>>;

@Injectable()
export class EnvSpecService {
  /** Catalog for the "add a service" picker. */
  serviceTypes() {
    return PRESET_TYPES.map((type) => {
      const p = SERVICE_PRESETS[type];
      return {
        type,
        defaultVersion: p.defaultVersion,
        port: p.port,
        hasCredentials: p.hasCredentials,
        dataPath: p.dataPath,
        image: p.image(p.defaultVersion),
      };
    });
  }

  /** Validate, turning the collected problems into a 400 the UI can render. */
  parse(input: unknown): EnvSpec {
    try {
      return parseEnvSpec(input);
    } catch (err) {
      if (err instanceof EnvSpecError) {
        throw new BadRequestException({
          message: "The environment spec has problems",
          problems: err.problems,
        });
      }
      throw err;
    }
  }

  /**
   * Compile a spec for one env.
   *
   * `existingSecrets` carries forward the credentials a previous compile
   * generated. Recompiling must never rotate a password — the database
   * container was initialized with the old one and would reject the new one,
   * which would look like data loss to the user. Anything missing is generated
   * fresh and returned for the caller to persist.
   */
  compile(args: {
    spec: EnvSpec;
    target: ComputeTarget;
    existingSecrets?: SpecSecrets | null;
  }): CompileResult & { secrets: SpecSecrets } {
    const secrets: SpecSecrets = cloneSecrets(args.existingSecrets);
    const result = compileToCompose(args.spec, {
      target: args.target,
      secret: (service, purpose) => {
        const forService = (secrets[service] ??= {});
        // Generated, not derived from a server secret: deriving would mean a
        // rotation of that secret silently changes every environment's
        // database password.
        forService[purpose] ??= randomBytes(18).toString("base64url");
        return forService[purpose];
      },
    });
    // Drop credentials for services the spec no longer has, so removing a
    // database doesn't leave its password lying in the row forever.
    for (const service of Object.keys(secrets)) {
      if (!(service in args.spec.services)) delete secrets[service];
    }
    return { ...result, secrets };
  }

  /** Validate + compile in one step, for previews and env creation. */
  parseAndCompile(args: {
    input: unknown;
    target: ComputeTarget;
    existingSecrets?: SpecSecrets | null;
  }) {
    const spec = this.parse(args.input);
    return { spec, ...this.compile({ ...args, spec }) };
  }

  /** Narrow a persisted JSON column back to a spec, or null when absent. */
  asSpec(value: unknown): EnvSpec | null {
    if (value === null || value === undefined) return null;
    return this.parse(value);
  }

  asSecrets(value: unknown): SpecSecrets | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== "object" || Array.isArray(value)) return null;
    return value as SpecSecrets;
  }
}

function cloneSecrets(value: SpecSecrets | null | undefined): SpecSecrets {
  if (!value) return {};
  const out: SpecSecrets = {};
  for (const [service, purposes] of Object.entries(value)) {
    if (typeof purposes !== "object" || purposes === null) continue;
    out[service] = { ...(purposes as Record<string, string>) };
  }
  return out;
}
