import { Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { TerminalController } from "./terminal.controller";
import { TerminalService } from "./terminal.service";

@Global()
@Module({
  imports: [AuthModule],
  controllers: [TerminalController],
  providers: [TerminalService],
  exports: [TerminalService],
})
export class TerminalModule {}
