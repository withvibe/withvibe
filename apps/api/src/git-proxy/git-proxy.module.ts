import { Module } from "@nestjs/common";
import { GitProxyController } from "./git-proxy.controller";
import { GitProxyService } from "./git-proxy.service";

/** Exported because the Fargate driver needs the remote URL and git config a
 * task must be started with — see GitProxyService.gitConfigEnvFor. */
@Module({
  controllers: [GitProxyController],
  providers: [GitProxyService],
  exports: [GitProxyService],
})
export class GitProxyModule {}
