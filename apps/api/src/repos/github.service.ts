import {
  BadRequestException,
  HttpException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";

type GithubRepo = {
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  clone_url: string;
  default_branch: string;
  pushed_at: string | null;
  owner: { login: string; avatar_url: string };
};

@Injectable()
export class GithubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService
  ) {}

  async listUserRepos(userId: string, workspaceId: string) {
    await this.access.member(userId, workspaceId);
    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { githubToken: true },
    });
    const token = ws?.githubToken || process.env.GITHUB_TOKEN;
    if (!token) {
      throw new BadRequestException({
        error: "No GitHub token configured",
        repos: [],
      });
    }

    const res = await fetch(
      "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401) {
        throw new UnauthorizedException({
          error: "GitHub token is invalid or lacks required scopes",
          detail: text.slice(0, 300),
          repos: [],
        });
      }
      throw new HttpException(
        {
          error: `GitHub API error (${res.status})`,
          detail: text.slice(0, 300),
          repos: [],
        },
        502
      );
    }

    const data = (await res.json()) as GithubRepo[];
    const repos = data.map((r) => ({
      fullName: r.full_name,
      name: r.name,
      owner: r.owner.login,
      avatar: r.owner.avatar_url,
      description: r.description,
      private: r.private,
      htmlUrl: r.html_url,
      cloneUrl: r.clone_url,
      defaultBranch: r.default_branch,
      pushedAt: r.pushed_at,
    }));
    return { repos };
  }
}
