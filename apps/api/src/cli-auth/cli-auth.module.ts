import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CliAuthController } from "./cli-auth.controller";
import { CliAuthService } from "./cli-auth.service";

@Module({
  imports: [AuthModule],
  controllers: [CliAuthController],
  providers: [CliAuthService],
  exports: [CliAuthService],
})
export class CliAuthModule {}
