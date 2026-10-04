import { Module } from "@nestjs/common";
import { GitProxyModule } from "../git-proxy/git-proxy.module";
import { GitController } from "./git.controller";
import { GitService } from "./git.service";

/** GitProxyModule supplies the per-(env, user) credential a sandbox repo's
 * git commands run with; the exec bridge itself comes from the global
 * ComputeModule. */
@Module({
  imports: [GitProxyModule],
  controllers: [GitController],
  providers: [GitService],
})
export class GitModule {}
