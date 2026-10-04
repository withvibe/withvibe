import { Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EnvSpecService } from "./env-spec.service";
import { EnvSpecController } from "./env-spec.controller";

/**
 * Global for the same reason the compute seam is: env creation, template
 * materialization and (later) the UI all need to compile a spec, and none of
 * them should have to import a module to do it.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [EnvSpecController],
  providers: [EnvSpecService],
  exports: [EnvSpecService],
})
export class EnvSpecModule {}
