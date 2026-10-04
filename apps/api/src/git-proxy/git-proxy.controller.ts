import { Controller, Get, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { GitProxyService } from "./git-proxy.service";

/**
 * Git's smart-HTTP endpoints, exposed for sandboxes.
 *
 * Deliberately outside the session-cookie world: the caller is a `git` process
 * in a Fargate task, which has no session and cannot acquire one. It
 * authenticates with the per-(env, user) token the service mints — see
 * GitProxyService — so every route here is authenticated, just not by the guard
 * the rest of the api uses.
 *
 * Responses are written straight to the raw `Response`: git speaks a binary
 * protocol with its own content types, and anything Nest might helpfully do to
 * a body would corrupt it.
 */
@Controller("git-proxy")
export class GitProxyController {
  constructor(private readonly proxy: GitProxyService) {}

  @Get(":envId/:repoName/info/refs")
  async infoRefs(
    @Param("envId") envId: string,
    @Param("repoName") repoName: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    await this.proxy.infoRefs(req, res, envId, repoName);
  }

  @Post(":envId/:repoName/git-upload-pack")
  async uploadPack(
    @Param("envId") envId: string,
    @Param("repoName") repoName: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    await this.proxy.uploadPack(req, res, envId, repoName);
  }

  @Post(":envId/:repoName/git-receive-pack")
  async receivePack(
    @Param("envId") envId: string,
    @Param("repoName") repoName: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    await this.proxy.receivePack(req, res, envId, repoName);
  }
}
