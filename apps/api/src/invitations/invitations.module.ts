import { Module } from "@nestjs/common";
import {
  TokenInvitationsController,
  WorkspaceInvitationsController,
} from "./invitations.controller";
import { InvitationsService } from "./invitations.service";

@Module({
  controllers: [WorkspaceInvitationsController, TokenInvitationsController],
  providers: [InvitationsService],
})
export class InvitationsModule {}
