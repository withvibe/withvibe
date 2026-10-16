import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import * as https from "https";
import type { Request, Response } from "express";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { PrismaService } from "../prisma/prisma.service";
import {
  personalCredential,
  missingCredentialMessage,
  type GitHubCredential,
} from "./github-credential";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { fargateApiBaseUrl } from "../compute/fargate/fargate-exec.service";
import { mintGitProxyToken, verifyGitProxyToken, tokenFromAuthHeader } from "./git-proxy-token";
import {
  forwardRemainder,
  readCommandList,
  rejectionReason,
  isDelete,
  type PushPolicy,
  type ReceivePackCommand,
} from "./git-pkt-line";

export type GitService = "git-upload-pack" | "git-receive-pack";

const SERVICES: GitService[] = ["git-upload-pack", "git-receive-pack"];

/** `Repo.name` is workspace-unique and ends up in a URL path. */
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** Request headers worth passing upstream. Everything else — above all
 * `authorization`, `cookie` and `host` — is dropped: the sandbox's credential
 * must never reach GitHub, and GitHub's must never come from the sandbox. */
const FORWARD_REQUEST_HEADERS = [
  "accept",
  "accept-encoding",
  "content-type",
  "content-length",
  "content-encoding",
  "git-protocol",
  "user-agent",
];

const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "content-encoding",
  "content-length",
  "cache-control",
  "expires",
  "pragma",
];

type ResolvedRequest = {
  envId: string;
  userId: string;
  workspaceId: string;
  repoName: string;
  /** Upstream repository, normalised to https and without credentials. */
  upstream: URL;
  credential: GitHubCredential | null;
  policy: PushPolicy;
};

/**
 * Git smart-HTTP proxy: the seam that lets a sandbox do real git work without
 * ever holding a GitHub credential.
 *
 * A Fargate sandbox runs in the *client's* AWS account, on infrastructure we do
 * not control and cannot audit. Handing it the workspace's GitHub token would
 * put a credential with push rights to every repo in the workspace inside that
 * blast radius permanently — a stop, a snapshot or a curious container would be
 * enough to walk away with it. So the token stays here. The sandbox points its
 * remotes at this endpoint, authenticates with a token that is worth nothing
 * anywhere else (see git-proxy-token.ts), and we attach the real credential on
 * the way out.
 *
 * Being in the middle is what makes policy possible at all: a push arrives here
 * as a readable list of ref updates before it reaches GitHub, so protected
 * branches can be refused, and every push is attributable to the person behind
 * it rather than to whoever owns the shared token.
 */
@Injectable()
export class GitProxyService {
  constructor(
    @InjectPinoLogger(GitProxyService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService
  ) {}

  // ---- addressing (consumed by the task bootstrap) ---------------------

  /** The remote a sandbox should clone from. Null when the api has no public
   * URL configured, which is also when a Fargate task could not reach it. */
  remoteUrlFor(envId: string, repoName: string): string | null {
    const base = fargateApiBaseUrl();
    if (!base) return null;
    return `${base.replace(/\/+$/, "")}/api/git-proxy/${envId}/${repoName}`;
  }

  /**
   * Environment that teaches every `git` process in the sandbox to authenticate
   * against the proxy, without writing the credential into any repository's
   * config. `GIT_CONFIG_*` applies to the whole process tree, so the agent's
   * ad-hoc git commands are covered as much as the bootstrap clone is, and the
   * header is scoped by URL prefix so it is never sent anywhere else.
   */
  gitConfigEnvFor(envId: string, userId: string): Record<string, string> {
    const base = fargateApiBaseUrl();
    if (!base) return {};
    const prefix = `${base.replace(/\/+$/, "")}/api/git-proxy/`;
    const token = mintGitProxyToken(envId, userId);
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${prefix}.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    };
  }

  // ---- request handling -------------------------------------------------

  /** `GET /info/refs?service=…` — the capability advertisement that opens
   * every fetch and every push. */
  async infoRefs(req: Request, res: Response, envId: string, repoName: string) {
    const service = String(req.query.service ?? "");
    if (!SERVICES.includes(service as GitService)) {
      throw new ForbiddenException(`unsupported git service "${service}"`);
    }
    const resolved = await this.resolve(req, envId, repoName);
    const url = new URL(resolved.upstream.toString());
    url.pathname += "/info/refs";
    url.searchParams.set("service", service);
    await this.pipeUpstream({ req, res, resolved, url, method: "GET" });
  }

  /** `POST /git-upload-pack` — a fetch. Read-only, so it is a pure relay. */
  async uploadPack(req: Request, res: Response, envId: string, repoName: string) {
    const resolved = await this.resolve(req, envId, repoName);
    const url = new URL(resolved.upstream.toString());
    url.pathname += "/git-upload-pack";
    await this.pipeUpstream({ req, res, resolved, url, method: "POST" });
  }

  /** `POST /git-receive-pack` — a push. The only request we read before
   * forwarding, because it is the only one that can change anything. */
  async receivePack(req: Request, res: Response, envId: string, repoName: string) {
    const resolved = await this.resolve(req, envId, repoName);

    // Git compresses fetch requests but never push requests — the packfile is
    // already compressed, so there is nothing to gain. An encoded push is
    // therefore something we have not seen, and reading the command list is
    // the whole point of this path, so refuse rather than wave it through.
    if (req.headers["content-encoding"]) {
      throw new ForbiddenException(
        `refusing a content-encoded push (${String(req.headers["content-encoding"])}): ` +
          `the command list must be readable for branch protection to apply`
      );
    }

    const { prefix, result, ended } = await readCommandList(req);
    if (result.status !== "ok") {
      const reason =
        result.status === "error"
          ? result.reason
          : "push ended before its command list was complete";
      throw new ForbiddenException(`refusing push: ${reason}`);
    }

    const rejection = rejectionReason(result.commands, resolved.policy);
    if (rejection) {
      this.logger.warn(
        `[git-proxy] denied push by user ${resolved.userId} to ${resolved.repoName} ` +
          `(env ${resolved.envId}): ${rejection}`
      );
      throw new ForbiddenException(rejection);
    }

    this.logger.info(
      `[git-proxy] push by user ${resolved.userId} to ${resolved.repoName} ` +
        `(env ${resolved.envId}): ${describe(result.commands)}`
    );

    const url = new URL(resolved.upstream.toString());
    url.pathname += "/git-receive-pack";
    await this.pipeUpstream({
      req,
      res,
      resolved,
      url,
      method: "POST",
      bodyPrefix: prefix,
      bodyEnded: ended,
    });
  }

  // ---- resolution -------------------------------------------------------

  private async resolve(
    req: Request,
    envId: string,
    repoName: string
  ): Promise<ResolvedRequest> {
    const token = tokenFromAuthHeader(req.headers.authorization);
    const claims = token ? verifyGitProxyToken(token) : null;
    if (!claims) {
      throw new UnauthorizedException("git proxy token missing or invalid");
    }
    if (claims.envId !== envId) {
      throw new ForbiddenException("token is not valid for this environment");
    }
    if (!REPO_NAME_RE.test(repoName)) {
      throw new NotFoundException("unknown repository");
    }

    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.deletedAt) throw new NotFoundException("Env not found");

    // The token says who; the membership table says whether they may still act.
    // Checking per request is what makes removing someone from a workspace take
    // effect on a sandbox that is already running.
    await this.access.member(claims.userId, env.workspaceId);

    // Only repos actually attached to this env are reachable — a sandbox must
    // not be able to read a sibling project just by renaming its remote.
    const envRepo = await this.prisma.client.envRepo.findFirst({
      where: { envId, repo: { name: repoName, workspaceId: env.workspaceId } },
      include: { repo: true },
    });
    if (!envRepo) throw new NotFoundException("unknown repository");

    const workspace = await this.prisma.client.workspace.findUnique({
      where: { id: env.workspaceId },
      select: { protectBaseBranch: true },
    });

    // The token in the request names a person, and this is that person's git
    // work — so it goes out with their GitHub token. Not the workspace's: a
    // shared token would give them whatever access it has rather than their
    // own, and record every push against the same account.
    const user = await this.prisma.client.user.findUnique({
      where: { id: claims.userId },
      select: { githubToken: true, githubLogin: true, githubUserId: true },
    });
    const credential = personalCredential({ user, workspace: null });

    return {
      envId,
      userId: claims.userId,
      workspaceId: env.workspaceId,
      repoName,
      upstream: toHttpsRemote(envRepo.repo.url),
      credential,
      policy: {
        protectBaseBranch: Boolean(workspace?.protectBaseBranch),
        baseBranch: envRepo.baseBranch,
      },
    };
  }

  // ---- streaming --------------------------------------------------------

  private pipeUpstream(args: {
    req: Request;
    res: Response;
    resolved: ResolvedRequest;
    url: URL;
    method: "GET" | "POST";
    bodyPrefix?: Buffer;
    bodyEnded?: boolean;
  }): Promise<void> {
    const { req, res, resolved, url, method, bodyPrefix, bodyEnded } = args;

    const headers: Record<string, string> = {};
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    if (resolved.credential) {
      const basic = Buffer.from(
        `x-access-token:${resolved.credential.token}`
      ).toString("base64");
      headers.authorization = `Basic ${basic}`;
    }

    return new Promise<void>((resolve) => {
      const upstream = https.request(
        {
          protocol: url.protocol,
          host: url.hostname,
          port: url.port || 443,
          method,
          path: `${url.pathname}${url.search}`,
          headers,
          timeout: 120_000,
        },
        (upstreamRes) => {
          const status = upstreamRes.statusCode ?? 502;
          const out: Record<string, string> = {};
          for (const name of FORWARD_RESPONSE_HEADERS) {
            const value = upstreamRes.headers[name];
            if (typeof value === "string") out[name] = value;
          }
          if (status >= 400) {
            this.logger.warn(
              `[git-proxy] upstream ${url.host} returned ${status} for ` +
                `${resolved.repoName} (env ${resolved.envId}, user ${resolved.userId})`
            );
          }
          // An upstream 401 with nothing to authenticate WITH is a
          // configuration problem, not a credential problem — and relaying it
          // verbatim sends git looking for a username for *this* host, so the
          // error names the proxy and reads as if we rejected them. Answer in
          // our own words, and with a status git will not try to retry.
          if (status === 401 && !resolved.credential) {
            upstreamRes.resume();
            res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
            res.end(`${missingCredentialMessage(url.host)}\n`);
            resolve();
            return;
          }
          res.writeHead(status, out);
          upstreamRes.pipe(res);
          upstreamRes.on("end", () => resolve());
          upstreamRes.on("error", () => {
            res.destroy();
            resolve();
          });
        }
      );

      upstream.on("error", (err) => {
        this.logger.error(`[git-proxy] upstream ${url.host} failed: ${err.message}`);
        if (!res.headersSent) res.status(502).json({ message: `git upstream failed: ${err.message}` });
        else res.destroy();
        resolve();
      });
      upstream.on("timeout", () => upstream.destroy(new Error("upstream timed out")));
      // The client hanging up must not leave a half-finished push in flight.
      res.on("close", () => upstream.destroy());

      if (method === "GET") {
        upstream.end();
        return;
      }
      forwardRemainder(req, upstream, bodyPrefix ?? Buffer.alloc(0), bodyEnded ?? false);
    });
  }
}

function describe(commands: ReceivePackCommand[]): string {
  return commands
    .map((c) => `${isDelete(c) ? "delete " : ""}${c.ref}`)
    .join(", ");
}

/**
 * Normalise a stored remote to a credential-free https URL ending in `.git`.
 *
 * Also the SSRF boundary: this service makes an outbound request to whatever
 * the URL says, from inside the platform network. The host is set by a
 * workspace admin rather than by the sandbox, so this is a guardrail rather
 * than a trust boundary — but a repo URL pointed at a metadata endpoint or a
 * neighbouring service should fail here, not succeed quietly.
 */
export function toHttpsRemote(raw: string): URL {
  let normalised = raw.trim();
  const ssh = normalised.match(/^(?:ssh:\/\/)?(?:git@)([^/:]+)[:/](.+)$/);
  if (ssh) normalised = `https://${ssh[1]}/${ssh[2].replace(/^\/+/, "")}`;
  if (!normalised.startsWith("https://")) {
    throw new ForbiddenException(`unsupported repository URL scheme: ${raw}`);
  }

  let url: URL;
  try {
    url = new URL(normalised);
  } catch {
    throw new ForbiddenException(`unparseable repository URL: ${raw}`);
  }
  // Credentials in the stored URL would be forwarded verbatim; strip them so
  // the only credential in play is the one this service attaches.
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  if (isPrivateHost(url.hostname)) {
    throw new ForbiddenException(`repository host is not routable from here: ${url.hostname}`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "") + ".git";
  return url;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd")) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local: the cloud metadata endpoint
  return false;
}
