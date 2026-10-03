import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { AuthUser } from "../../auth/jwt.strategy";
import { WorkspaceAccessService } from "../../common/workspace-access.service";
import { AwsConnectionService } from "./aws-connection.service";
import { AwsClientsService } from "./aws-clients.service";
import type { AwsComputeConnectionModel as AwsComputeConnection } from "@withvibe/db";

/**
 * Admin-only management of the workspace's client-AWS-account connection
 * (where fargate sandboxes deploy). GET also powers the settings panel's
 * "deploy this stack" instructions: it returns the externalId + the
 * platform's account id, the two CloudFormation parameters the client needs.
 */
@Controller("workspaces/:workspaceId/compute/aws")
@UseGuards(JwtAuthGuard)
export class AwsConnectionController {
  constructor(
    private readonly connections: AwsConnectionService,
    private readonly aws: AwsClientsService,
    private readonly access: WorkspaceAccessService
  ) {}

  @Get()
  async get(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string
  ) {
    await this.access.admin(user.id, workspaceId);
    const conn = await this.connections.getOrCreate(workspaceId);
    const platformAccountId = await this.aws.platformIdentity();
    return {
      ...this.view(conn),
      platformAccountId,
      platformCredsPresent: platformAccountId !== null,
    };
  }

  @Post("connect")
  async connect(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Body() body: { roleArn?: unknown; region?: unknown }
  ) {
    await this.access.admin(user.id, workspaceId);
    const conn = await this.connections.connect(workspaceId, body);
    return this.view(conn);
  }

  @Post("verify")
  async verify(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string
  ) {
    await this.access.admin(user.id, workspaceId);
    const conn = await this.connections.verify(workspaceId);
    return this.view(conn);
  }

  @Delete()
  async disconnect(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string
  ) {
    await this.access.admin(user.id, workspaceId);
    await this.connections.disconnect(workspaceId);
    return { ok: true };
  }

  private view(conn: AwsComputeConnection) {
    return {
      status: conn.status,
      externalId: conn.externalId,
      roleArn: conn.roleArn,
      region: conn.region,
      clusterArn: conn.clusterArn,
      logGroupName: conn.logGroupName,
      lastError: conn.lastError,
      lastVerifiedAt: conn.lastVerifiedAt,
    };
  }
}
