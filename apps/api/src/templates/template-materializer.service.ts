import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { readFile } from "fs/promises";
import path from "path";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { ConfigService } from "@nestjs/config";
import { PortAllocatorService } from "../ports/port-allocator.service";
import {
  TemplateVariable,
  parseTemplateServices,
  parseTemplateVariables,
} from "./template.types";
import {
  rebaseBuildPaths,
  rewriteComposeForSubdomain,
  readTcpExposed,
  injectPublishedPort,
} from "./compose-rewriter";
import { AgentVariableBinderService } from "./agent-variable-binder.service";
import { SecretsService } from "../workspaces/secrets.service";
import { EnvCloneService } from "../env-clones/env-clone.service";
import { composeProjectName } from "../docker/compose-naming";

// ${VAR_NAME} — uppercase letters/digits/underscore, must start with a letter.
const INTERPOLATION_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g;

export type MaterializeResult = {
  composeFile: string;                    // raw yaml, with ${VAR} left intact so `docker compose` reads `.env`
  resolvedVars: Record<string, string>;   // what got written to `.env`
  allocatedPorts: Record<string, number>; // subset — the ones PortAllocator assigned
};

export type BundleAsset = {
  path: string;
  content: string;
  // When true the CLI must run ${VAR} interpolation against the final vars
  // map (after local port allocation). When false the content is verbatim.
  isTemplate: boolean;
};

// Everything the CLI needs to materialize an env locally. Ports are NOT
// allocated server-side — the CLI picks free host ports on the user's
// machine and substitutes them into the compose at materialize time.
export type LocalBundleFromTemplate = {
  kind: "template";
  composeFile: string;                   // raw, with ${VAR} placeholders
  // Vars already resolvable without touching user-machine state. Covers
  // user-input (from env.templateVars), secret (from API process env),
  // default, and reserved (PUBLIC_HOST=localhost).
  resolvedVars: Record<string, string>;
  // Keys the CLI must locally assign free ports to before writing .env.
  portKeys: string[];
  assets: BundleAsset[];
};

export type LocalBundleFromCustom = {
  kind: "custom";
  // User-provided compose — no interpolation, no asset materialization
  // (custom compose flow doesn't have templated assets).
  composeFile: string;
};

/**
 * Materializes a template into an env's on-disk workspace.
 *
 * Why leave ${VAR} in the compose file literal: docker compose already does
 * its own `.env` interpolation, so we write `.env` next to the compose file
 * and let compose resolve. Asset files, on the other hand, are bind-mounted
 * into containers verbatim — compose doesn't touch their contents — so
 * template-kind assets get substituted here.
 */
@Injectable()
export class TemplateMaterializerService {
  private readonly logger = new Logger(TemplateMaterializerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: PortAllocatorService,
    private readonly config: ConfigService,
    private readonly agentBinder: AgentVariableBinderService,
    private readonly secrets: SecretsService,
    private readonly storage: StorageService,
    private readonly envClones: EnvCloneService
  ) {}

  /**
   * Values the orchestrator injects into every template automatically.
   * Template authors reference them as ${KEY} in compose / assets without
   * declaring them in the variables list.
   */
  private reservedVars(): Record<string, string> {
    return {
      // The public hostname browsers use to reach this env's published ports.
      // Defaults to "localhost" for dev-on-laptop. In shared deployments set
      // PUBLIC_HOST in the API process env (e.g. "dev-box.internal" or an IP).
      PUBLIC_HOST: this.config.get<string>("PUBLIC_HOST") || "localhost",
    };
  }

  /**
   * Per-env external Docker network Traefik is connected to for THIS env's
   * subdomain routing. Phase 2 multi-tenant isolation: every subdomain env
   * gets its OWN network (`<project>-edge`) instead of all envs sharing one
   * flat proxy net, so one env's bare service name can never resolve to
   * another env's container. DockerService creates/removes this network and
   * (dis)connects Traefik around the env lifecycle; the name is deterministic
   * from the envId so both sides agree without extra plumbing.
   */
  private perEnvProxyNetwork(envId: string): string {
    return `${composeProjectName(envId)}-edge`;
  }

  /** Phase 4 — external TCP exposure (e.g. a DB reachable from another
   * machine). OFF by default; the operator must set WITHVIBE_TCP_EXPOSE and
   * allowlist the env (by id) or its template (by id or slug). Optional
   * WITHVIBE_TCP_BIND pins the publish to one host interface (e.g. a VPN IP)
   * instead of all interfaces. Fail-closed: unauthorized → no port published. */
  private tcpExposeAllowed(
    envId: string,
    templateId: string,
    templateSlug: string
  ): boolean {
    if (!(this.config.get<string>("WITHVIBE_TCP_EXPOSE") || "").trim())
      return false;
    const csv = (name: string): Set<string> =>
      new Set(
        (this.config.get<string>(name) || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
    if (csv("WITHVIBE_TCP_EXPOSE_ENVS").has(envId)) return true;
    const tpls = csv("WITHVIBE_TCP_EXPOSE_TEMPLATES");
    return tpls.has(templateId) || tpls.has(templateSlug);
  }

  /**
   * Traefik entrypoint name the env's router binds to. Must match the
   * entrypoint declared in Traefik's static config (typically "websecure"
   * for the HTTPS :443 entrypoint). Override via TRAEFIK_ENTRYPOINT.
   */
  private traefikEntrypoint(): string {
    return this.config.get<string>("TRAEFIK_ENTRYPOINT") || "websecure";
  }

  /**
   * Traefik certresolver name for issuing TLS certs (Let's Encrypt etc.).
   * Returns null when the operator wants no TLS labels — useful for local
   * dev or when an upstream LB terminates TLS. Override via
   * TRAEFIK_CERT_RESOLVER (set to empty string to disable).
   */
  private traefikCertResolver(): string | null {
    const v = this.config.get<string>("TRAEFIK_CERT_RESOLVER");
    if (v === undefined) return "letsencrypt";
    return v.trim() || null;
  }

  async materialize(args: {
    envId: string;
    workspaceId: string;
    templateId: string;
    userVars: Record<string, string>;
  }): Promise<MaterializeResult> {
    const tpl = await this.prisma.client.envTemplate.findUnique({
      where: { id: args.templateId },
      include: {
        assets: true,
        repos: { include: { repo: { select: { name: true } } } },
      },
    });
    if (!tpl || tpl.workspaceId !== args.workspaceId) {
      throw new NotFoundException("Template not found");
    }

    // Empty composeFile is a contract that the env should use the template's
    // (single) attached repo's own docker-compose.yml. The env-create flow
    // sync-clones the repo before calling us, so the file is on disk.
    let sourceComposeYaml = tpl.composeFile;
    if (!sourceComposeYaml.trim()) {
      if (tpl.repos.length !== 1) {
        throw new BadRequestException(
          `Template "${tpl.slug}" has no composeFile and ${tpl.repos.length} ` +
            "repos attached — exactly one is required."
        );
      }
      const repoName = tpl.repos[0].repo.name;
      const clonePath = this.envClones.envClonePath(
        args.workspaceId,
        args.envId,
        repoName
      );
      const composePath = path.join(clonePath, "docker-compose.yml");
      try {
        sourceComposeYaml = await readFile(composePath, "utf8");
      } catch (err) {
        throw new BadRequestException(
          `Template "${tpl.slug}" expects ${repoName}/docker-compose.yml, ` +
            `but it could not be read at ${composePath}: ` +
            (err instanceof Error ? err.message : String(err))
        );
      }
      // The repo's compose was authored to be run from the repo root. Once
      // we promote it to the env root, relative `build:` paths (`build: .`)
      // point at the env dir which has no Dockerfile. Rebase them so they
      // keep resolving inside the repo subdirectory.
      sourceComposeYaml = rebaseBuildPaths(sourceComposeYaml, repoName);
      this.logger.log(
        `Env ${args.envId} using repo "${repoName}" docker-compose.yml as ` +
          `source (template "${tpl.slug}" has empty composeFile)`
      );
    }

    const env = await this.prisma.client.env.findUnique({
      where: { id: args.envId },
      select: {
        title: true,
        description: true,
        routingMode: true,
        routingBaseDomain: true,
      },
    });
    const subdomainMode = env?.routingMode === "subdomain";
    const baseDomain = env?.routingBaseDomain?.trim() || null;
    if (subdomainMode && !baseDomain) {
      throw new BadRequestException(
        "Env routingMode is 'subdomain' but routingBaseDomain is not set"
      );
    }

    const variables = parseTemplateVariables(tpl.variables);

    // Port allocation is only meaningful in port mode — subdomain mode publishes
    // no host ports, so reserving them would waste the pool.
    const portKeys = subdomainMode
      ? []
      : variables.filter((v) => v.kind === "system-port").map((v) => v.key);
    const allocatedPorts = await this.ports.allocate(args.envId, portKeys);

    // In subdomain mode we don't allocate host ports. Services talk to each
    // other on the Docker network using their container-internal ports, and
    // asset configs (e.g. a backend's `app.properties` with ${BACKEND_PORT})
    // mean "the port the service listens on inside the container". The
    // template author's `defaultValue` carries that — fall back to "" if
    // missing so interpolation doesn't hard-fail on a stray reference.
    const varsToResolve: TemplateVariable[] = subdomainMode
      ? variables.map((v) =>
          v.kind === "system-port"
            ? { ...v, kind: "default", defaultValue: v.defaultValue ?? "" }
            : v
        )
      : variables;

    // Rewrite compose BEFORE writing .env so per-service URLs can be injected
    // as URL_<SVC> vars. This lets templates reference other services like:
    //   REACT_APP_API_URL=${URL_SERVLET}
    // and get a different hostname per env without hardcoding.
    let composeToWrite = sourceComposeYaml;
    let serviceUrls: Record<string, string> = {};
    if (subdomainMode && baseDomain) {
      const rewritten = rewriteComposeForSubdomain({
        composeYaml: sourceComposeYaml,
        envId: args.envId,
        baseDomain,
        proxyNetworkName: this.perEnvProxyNetwork(args.envId),
        traefikEntrypoint: this.traefikEntrypoint(),
        traefikCertResolver: this.traefikCertResolver(),
      });
      composeToWrite = rewritten.composeYaml;
      serviceUrls = rewritten.serviceUrls;
      this.logger.log(
        `Env ${args.envId} compose rewritten for subdomain routing: ` +
          `${rewritten.exposedServices.length} service(s) exposed via ${baseDomain}`
      );
    }

    // Phase 4: publish a unique host port for services that opted into
    // external TCP access — but ONLY for operator-authorized envs. Runs in
    // both routing modes (works on the post-rewrite compose). The marker
    // alone grants nothing; this is the single place the port is published.
    const tcpServices = readTcpExposed(composeToWrite);
    if (tcpServices.length > 0) {
      const names = tcpServices.map((t) => t.service).join(", ");
      if (this.tcpExposeAllowed(args.envId, tpl.id, tpl.slug)) {
        const bindIp =
          (this.config.get<string>("WITHVIBE_TCP_BIND") || "").trim() ||
          undefined;
        const host = this.config.get<string>("PUBLIC_HOST") || "localhost";
        for (const { service, containerPort } of tcpServices) {
          const key = `tcp_${service}`;
          const { [key]: hostPort } = await this.ports.allocate(args.envId, [
            key,
          ]);
          composeToWrite = injectPublishedPort(
            composeToWrite,
            service,
            hostPort,
            containerPort,
            bindIp
          );
          allocatedPorts[key] = hostPort;
          this.logger.log(
            `Env ${args.envId} TCP-exposed ${service}: ` +
              `${bindIp ? bindIp + ":" : ""}${host}:${hostPort} → :${containerPort}`
          );
        }
      } else {
        this.logger.warn(
          `Env ${args.envId}: service(s) ${names} request x-expose-tcp but ` +
            `the env is not authorized (set WITHVIBE_TCP_EXPOSE and allowlist ` +
            `the env id or template via WITHVIBE_TCP_EXPOSE_ENVS / ` +
            `WITHVIBE_TCP_EXPOSE_TEMPLATES) — NOT publishing any port`
        );
      }
    }

    const reserved = this.reservedVars();
    const workspaceSecrets = await this.secrets.loadForMaterialization(
      args.workspaceId
    );

    // Reserved vars are spread LAST so orchestrator values always win — even
    // if a bypass somehow smuggled a reserved key into `variables`. Parse-time
    // validation is the primary defense; this is belt-and-suspenders.
    const resolvedVars: Record<string, string> = {
      ...this.resolveVariables(varsToResolve, {
        userVars: args.userVars,
        allocatedPorts,
        serviceUrls,
        publicHost: reserved.PUBLIC_HOST,
        workspaceSecrets,
      }),
      ...reserved,
    };

    // Agent pass: for variables the deterministic resolver left empty, ask
    // Claude to propose values from the compose + env context + the var's
    // description. Silent on failure; materialization is never blocked.
    const emptyVars = varsToResolve.filter(
      (v) => !(v.key in reserved) && (resolvedVars[v.key] ?? "") === ""
    );
    this.logger.log(
      `Env ${args.envId} deterministic resolution: ${varsToResolve.length} vars, ` +
        `${emptyVars.length} empty → [${emptyVars.map((v) => v.key).join(", ")}]`
    );
    if (emptyVars.length > 0) {
      const bindResult = await this.agentBinder.bindEmpty({
        workspaceId: args.workspaceId,
        envTitle: env?.title ?? null,
        envDescription: env?.description ?? null,
        routingMode: subdomainMode ? "subdomain" : "port",
        routingBaseDomain: baseDomain,
        composeFile: composeToWrite,
        resolvedVars,
        emptyVars,
        agentInstructions: tpl.agentInstructions ?? null,
        services: parseTemplateServices(tpl.services ?? []),
      });
      for (const [k, v] of Object.entries(bindResult.proposals)) {
        resolvedVars[k] = v;
      }
    }

    await this.storage.writeFile(
      args.workspaceId,
      args.envId,
      ".env",
      this.renderDotEnv(resolvedVars)
    );

    await this.storage.writeFile(
      args.workspaceId,
      args.envId,
      "docker-compose.yml",
      composeToWrite
    );

    // Persist deterministic per-service URLs so the UI can show them before
    // the container even starts. Port-mode envs leave this null and keep
    // using `containerPorts` populated by DockerService at start time.
    if (subdomainMode) {
      await this.prisma.client.env.update({
        where: { id: args.envId },
        data: { serviceUrls },
      });
    }

    for (const asset of tpl.assets) {
      // Defense-in-depth: reject paths that try to escape the env root. The
      // CRUD layer already validates this, but cheap to double-check before
      // we hand the path to the storage provider.
      const target = path.posix.normalize(asset.path);
      if (target.startsWith("../") || path.isAbsolute(target)) {
        throw new BadRequestException(
          `Template asset path escapes env dir: ${asset.path}`
        );
      }
      const content = asset.isTemplate
        ? this.interpolate(asset.content, resolvedVars, `asset:${asset.path}`)
        : asset.content;
      await this.storage.writeFile(
        args.workspaceId,
        args.envId,
        target,
        content
      );
    }

    // Surface freshly written files into the env clone so the DevOps agent and
    // Docker can see them immediately (no-op when storage IS the env clone dir).
    await this.storage.syncToEnvClone(args.workspaceId, args.envId);

    this.logger.log(
      `Materialized template ${tpl.slug} into env ${args.envId}: ` +
        `${tpl.assets.length} asset(s), ${portKeys.length} port(s) allocated`
    );

    return { composeFile: composeToWrite, resolvedVars, allocatedPorts };
  }

  /**
   * Local-mode counterpart of `materialize`: builds the bundle data without
   * writing to disk or allocating host ports server-side. The CLI on the
   * user's machine writes files and picks free ports.
   *
   * For local bundles we deliberately force PUBLIC_HOST=localhost regardless
   * of the server-side config (a shared API may have it set to a hostname
   * that doesn't resolve from the user's laptop).
   */
  async renderBundleForTemplate(args: {
    templateId: string;
    workspaceId: string;
    userVars: Record<string, string>;
  }): Promise<LocalBundleFromTemplate> {
    const tpl = await this.prisma.client.envTemplate.findUnique({
      where: { id: args.templateId },
      include: { assets: true },
    });
    if (!tpl || tpl.workspaceId !== args.workspaceId) {
      throw new NotFoundException("Template not found");
    }
    if (!tpl.composeFile.trim()) {
      // Local bundles can't sync-clone server-side, so the "use repo's
      // compose" feature is server-only. Surface a clear error rather than
      // shipping an empty compose down to the CLI.
      throw new BadRequestException(
        `Template "${tpl.slug}" has an empty composeFile — that mode is only ` +
          "supported for server-hosted envs (the platform clones the repo " +
          "before materializing). Local bundles need a populated composeFile."
      );
    }

    const variables = parseTemplateVariables(tpl.variables);
    const portKeys = variables
      .filter((v) => v.kind === "system-port")
      .map((v) => v.key);

    // Resolve everything EXCEPT system-port. The CLI allocates those locally
    // then writes .env itself. We still include the system-port keys as
    // placeholders so the CLI knows the full set of vars to render.
    const nonPortVars = variables.filter((v) => v.kind !== "system-port");
    const workspaceSecrets = await this.secrets.loadForMaterialization(
      args.workspaceId
    );
    const resolvedVars: Record<string, string> = {
      ...this.resolveVariables(nonPortVars, {
        userVars: args.userVars,
        allocatedPorts: {},
        workspaceSecrets,
      }),
      // Local envs always talk to themselves via localhost.
      PUBLIC_HOST: "localhost",
    };

    const assets: BundleAsset[] = tpl.assets.map((a) => ({
      path: a.path,
      content: a.content,
      isTemplate: a.isTemplate,
    }));

    return {
      kind: "template",
      composeFile: tpl.composeFile,
      resolvedVars,
      portKeys,
      assets,
    };
  }

  private resolveVariables(
    variables: TemplateVariable[],
    ctx: {
      userVars: Record<string, string>;
      allocatedPorts: Record<string, number>;
      serviceUrls?: Record<string, string>;
      publicHost?: string;
      workspaceSecrets?: Record<string, string>;
    }
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const v of variables) {
      switch (v.kind) {
        case "system-port": {
          const port = ctx.allocatedPorts[v.key];
          if (typeof port !== "number") {
            throw new Error(`PortAllocator did not return a port for ${v.key}`);
          }
          out[v.key] = String(port);
          break;
        }
        case "user-input": {
          const provided = ctx.userVars[v.key];
          if (typeof provided === "string" && provided.length > 0) {
            out[v.key] = provided;
          } else if (typeof v.defaultValue === "string") {
            out[v.key] = v.defaultValue;
          } else if (v.required) {
            throw new BadRequestException(
              `Missing required input for template variable "${v.key}"` +
                (v.label ? ` (${v.label})` : "")
            );
          } else {
            out[v.key] = "";
          }
          break;
        }
        case "secret": {
          const secretEnvName = v.secretName || v.key;
          // Lookup order: workspace secrets store first (UI-managed,
          // per-workspace), then API process env (legacy fallback for
          // pre-existing deployments).
          const fromWorkspace = ctx.workspaceSecrets?.[secretEnvName];
          if (typeof fromWorkspace === "string") {
            out[v.key] = fromWorkspace;
            break;
          }
          const value = process.env[secretEnvName];
          if (value == null) {
            this.logger.warn(
              `Secret "${secretEnvName}" is not set in workspace store or API ` +
                `process env — substituting empty string for template variable "${v.key}"`
            );
            out[v.key] = "";
          } else {
            out[v.key] = value;
          }
          break;
        }
        case "default": {
          if (typeof v.defaultValue !== "string") {
            throw new Error(
              `Template variable "${v.key}" kind=default has no defaultValue`
            );
          }
          out[v.key] = v.defaultValue;
          break;
        }
        case "service-url": {
          // No `service` → leave empty; the agent pass will infer it from
          // the variable's description + compose context.
          if (!v.service) {
            out[v.key] = "";
            break;
          }
          // Subdomain mode: rewriter already computed the hostname.
          const fromRewriter = ctx.serviceUrls?.[v.service];
          if (fromRewriter) {
            out[v.key] = fromRewriter;
            break;
          }
          // Port mode: derive from PUBLIC_HOST + the template-declared portKey.
          if (v.portKey) {
            const port = ctx.allocatedPorts[v.portKey];
            if (typeof port === "number") {
              const host = ctx.publicHost ?? "localhost";
              out[v.key] = `http://${host}:${port}`;
              break;
            }
          }
          // No match — emit empty so `.env` interpolation doesn't blow up.
          // The template author probably forgot `portKey` for port-mode
          // support, or the `service` name doesn't match any compose service.
          this.logger.warn(
            `service-url var "${v.key}" could not resolve (service="${v.service}", ` +
              `portKey="${v.portKey ?? "none"}") — substituting empty string`
          );
          out[v.key] = "";
          break;
        }
      }
    }
    return out;
  }

  private renderDotEnv(vars: Record<string, string>): string {
    const lines = ["# Generated by TemplateMaterializerService — do not edit by hand."];
    for (const [k, v] of Object.entries(vars)) {
      lines.push(`${k}=${this.quoteDotEnvValue(v)}`);
    }
    return lines.join("\n") + "\n";
  }

  private quoteDotEnvValue(v: string): string {
    const escaped = v
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r");
    return `"${escaped}"`;
  }

  private interpolate(
    body: string,
    vars: Record<string, string>,
    where: string
  ): string {
    return body.replace(INTERPOLATION_RE, (_, key: string) => {
      if (!(key in vars)) {
        throw new BadRequestException(
          `Unknown template variable "${key}" referenced in ${where}`
        );
      }
      return vars[key];
    });
  }
}
