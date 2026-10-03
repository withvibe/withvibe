import { Injectable } from "@nestjs/common";
import { mkdir, writeFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { envShortId } from "../../templates/compose-rewriter";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

/**
 * Publishes routing for Fargate envs through Traefik's FILE provider.
 *
 * Local envs get routed by Traefik's Docker provider reading container
 * labels — meaningless for a task running in the client's cloud. Instead,
 * when a Fargate env reaches RUNNING we write one dynamic-config fragment
 * mapping each exposed service's hostname (same `<svc>-<short>.<base>`
 * convention the compose rewriter uses for local envs) to the task's
 * SG-guarded public IP. Traefik watches the directory, so routes appear and
 * disappear with no restarts. Fragments survive api restarts on disk; stop
 * removes them.
 *
 * The directory is shared with the Traefik container by the installer
 * (`./traefik-dynamic` in the install dir — the same dir the BYOCERT
 * variant already mounts). `TRAEFIK_DYNAMIC_DIR` points the api at it; the
 * dev default keeps everything under ~/.withvibe.
 */
@Injectable()
export class TraefikDynamicService {
  constructor(
    @InjectPinoLogger(TraefikDynamicService.name)
    private readonly logger: PinoLogger
  ) {}

  private dir(): string {
    return (
      process.env.TRAEFIK_DYNAMIC_DIR ||
      path.join(os.homedir(), ".withvibe", "traefik-dynamic")
    );
  }

  private fragmentPath(envId: string): string {
    // envId is a cuid (alphanumeric) — safe as a filename.
    return path.join(this.dir(), `wv-env-${envId}.yml`);
  }

  // Parity with the label-based config the compose rewriter emits for local
  // envs (template-materializer traefikEntrypoint/traefikCertResolver).
  private entrypoint(): string {
    return process.env.TRAEFIK_ENTRYPOINT || "websecure";
  }
  private certResolver(): string {
    const v = process.env.TRAEFIK_CERT_RESOLVER;
    return v === undefined ? "letsencrypt" : v;
  }

  /** Same scheme rule as the compose rewriter: local-looking base domains
   * can't get real certs, so they serve plain http. */
  isLocalBase(baseDomain: string): boolean {
    return (
      baseDomain === "localhost" ||
      baseDomain.endsWith(".localhost") ||
      baseDomain.endsWith(".nip.io") ||
      baseDomain.endsWith(".sslip.io")
    );
  }

  hostFor(envId: string, service: string, baseDomain: string): string {
    return `${service}-${envShortId(envId)}.${baseDomain}`;
  }

  urlFor(envId: string, service: string, baseDomain: string): string {
    const scheme = this.isLocalBase(baseDomain) ? "http" : "https";
    return `${scheme}://${this.hostFor(envId, service, baseDomain)}`;
  }

  /**
   * Write (or overwrite) the env's routing fragment. `servicePorts` is the
   * translator's map; services without ports aren't exposed. Returns the
   * public URL per exposed service (what Env.serviceUrls stores).
   */
  async publishEnvRoutes(input: {
    envId: string;
    baseDomain: string;
    taskIp: string;
    servicePorts: Record<string, number[]>;
  }): Promise<Record<string, string>> {
    const { envId, baseDomain, taskIp, servicePorts } = input;
    const short = envShortId(envId);
    const exposed = Object.entries(servicePorts).filter(
      ([, ports]) => ports.length > 0
    );
    if (exposed.length === 0) return {};

    const tlsOn = !this.isLocalBase(baseDomain);
    const resolver = this.certResolver();
    const urls: Record<string, string> = {};
    const routers: string[] = [];
    const services: string[] = [];
    for (const [svc, ports] of exposed) {
      const key = `wvf-${short}-${svc}`;
      const host = this.hostFor(envId, svc, baseDomain);
      urls[svc] = this.urlFor(envId, svc, baseDomain);
      routers.push(
        [
          `    ${key}:`,
          `      rule: Host(\`${host}\`)`,
          `      entryPoints: ["${this.entrypoint()}"]`,
          `      service: ${key}`,
          ...(tlsOn
            ? [
                `      tls:`,
                ...(resolver ? [`        certResolver: ${resolver}`] : [`        {}`]),
              ]
            : []),
        ].join("\n")
      );
      services.push(
        [
          `    ${key}:`,
          `      loadBalancer:`,
          `        servers:`,
          `          - url: "http://${taskIp}:${ports[0]}"`,
        ].join("\n")
      );
    }

    const body = [
      `# Managed by WithVibe — Fargate env ${envId}. Do not edit; removed on env stop.`,
      `http:`,
      `  routers:`,
      routers.join("\n"),
      `  services:`,
      services.join("\n"),
      ``,
    ].join("\n");

    await mkdir(this.dir(), { recursive: true });
    await writeFile(this.fragmentPath(envId), body, "utf-8");
    this.logger.info(
      `[traefik-dynamic] published ${exposed.length} route(s) for env ${envId} → ${taskIp}`
    );
    return urls;
  }

  /** Best-effort removal — a leftover fragment only yields a 502 for a dead
   * IP, but we still never want stale routes outliving their env. */
  async removeEnvRoutes(envId: string): Promise<void> {
    try {
      await rm(this.fragmentPath(envId), { force: true });
    } catch (err) {
      this.logger.warn(
        `[traefik-dynamic] could not remove fragment for ${envId}: ${err}`
      );
    }
  }
}
