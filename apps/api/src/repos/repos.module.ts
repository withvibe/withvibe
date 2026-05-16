import { Module } from "@nestjs/common";
import { ReposController } from "./repos.controller";
import { ReposService } from "./repos.service";
import { GithubController } from "./github.controller";
import { GithubService } from "./github.service";

@Module({
  controllers: [ReposController, GithubController],
  providers: [ReposService, GithubService],
  exports: [ReposService],
})
export class ReposModule {}
