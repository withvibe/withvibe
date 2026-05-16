import { Module } from "@nestjs/common";
import { TemplatesController } from "./templates.controller";
import { TemplatesService } from "./templates.service";
import { TemplateMaterializerService } from "./template-materializer.service";
import { AgentVariableBinderService } from "./agent-variable-binder.service";
import { TemplateAssistService } from "./template-assist.service";
import { WorkspacesModule } from "../workspaces/workspaces.module";

@Module({
  imports: [WorkspacesModule],
  controllers: [TemplatesController],
  providers: [
    TemplatesService,
    TemplateMaterializerService,
    AgentVariableBinderService,
    TemplateAssistService,
  ],
  exports: [TemplatesService, TemplateMaterializerService],
})
export class TemplatesModule {}
