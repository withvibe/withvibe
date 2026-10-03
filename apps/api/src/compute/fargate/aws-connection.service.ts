import { BadRequestException, Injectable } from "@nestjs/common";
import { randomBytes } from "crypto";
import { ListExportsCommand } from "@aws-sdk/client-cloudformation";
import type { AwsComputeConnectionModel as AwsComputeConnection } from "@withvibe/db";
import { PrismaService } from "../../prisma/prisma.service";
import { AwsClientsService } from "./aws-clients.service";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

/** Export names written by infra/aws/withvibe-client-compute.cfn.yaml. */
const EXPORTS = {
  cluster: "WithVibe-ClusterArn",
  subnets: "WithVibe-SubnetIds",
  securityGroup: "WithVibe-SecurityGroupId",
  logGroup: "WithVibe-LogGroup",
  taskExecutionRole: "WithVibe-TaskExecutionRoleArn",
  taskRole: "WithVibe-TaskRoleArn",
} as const;

const ROLE_ARN_RE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

/**
 * Per-workspace connection to the CLIENT AWS account that hosts this
 * workspace's fargate sandboxes.
 *
 * Flow: `getOrCreate` issues a stable externalId → the client deploys the
 * CloudFormation stack with that externalId + the platform account id →
 * `connect(roleArn, region)` → `verify()` assumes the role and discovers the
 * stack's exports. The connection is usable (status "ok") only after a
 * successful verify, and EnvsService refuses to create fargate envs without
 * one.
 */
@Injectable()
export class AwsConnectionService {
  constructor(
    @InjectPinoLogger(AwsConnectionService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly aws: AwsClientsService
  ) {}

  async getOrCreate(workspaceId: string): Promise<AwsComputeConnection> {
    const existing = await this.prisma.client.awsComputeConnection.findUnique({
      where: { workspaceId },
    });
    if (existing) return existing;
    return this.prisma.client.awsComputeConnection.create({
      data: {
        workspaceId,
        // Stable per workspace; baked into the client's role trust policy.
        externalId: `wv-${randomBytes(16).toString("hex")}`,
      },
    });
  }

  async get(workspaceId: string): Promise<AwsComputeConnection | null> {
    return this.prisma.client.awsComputeConnection.findUnique({
      where: { workspaceId },
    });
  }

  /** A verified, usable connection — what the Fargate driver requires. */
  async getVerified(workspaceId: string): Promise<AwsComputeConnection> {
    const conn = await this.get(workspaceId);
    if (!conn || conn.status !== "ok" || !conn.roleArn || !conn.region) {
      throw new BadRequestException(
        "This workspace has no verified AWS compute connection. " +
          "Connect a client AWS account in Settings before using Fargate envs."
      );
    }
    return conn;
  }

  async connect(
    workspaceId: string,
    input: { roleArn?: unknown; region?: unknown }
  ): Promise<AwsComputeConnection> {
    const roleArn = typeof input.roleArn === "string" ? input.roleArn.trim() : "";
    const region = typeof input.region === "string" ? input.region.trim() : "";
    if (!ROLE_ARN_RE.test(roleArn)) {
      throw new BadRequestException(
        "roleArn must be an IAM role ARN (arn:aws:iam::<account>:role/...)"
      );
    }
    if (!REGION_RE.test(region)) {
      throw new BadRequestException("region must be a valid AWS region id");
    }
    const conn = await this.getOrCreate(workspaceId);
    if (conn.roleArn && conn.region) {
      this.aws.evict({ roleArn: conn.roleArn, region: conn.region });
    }
    await this.prisma.client.awsComputeConnection.update({
      where: { workspaceId },
      data: { roleArn, region, status: "pending", lastError: null },
    });
    return this.verify(workspaceId);
  }

  /**
   * Assume the client role and discover the stack's exports. Both proves the
   * trust policy (role + externalId) works and fills in everything the
   * driver needs — the user only ever pastes two values.
   */
  async verify(workspaceId: string): Promise<AwsComputeConnection> {
    const conn = await this.getOrCreate(workspaceId);
    if (!conn.roleArn || !conn.region) {
      throw new BadRequestException(
        "Connect first: provide the PlatformAccessRole ARN and region."
      );
    }
    if ((await this.aws.platformIdentity()) === null) {
      return this.fail(
        workspaceId,
        "The platform api has no working AWS credentials (set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or AWS_PROFILE on the api)."
      );
    }
    try {
      const { cfn } = this.aws.clientsFor({
        roleArn: conn.roleArn,
        externalId: conn.externalId,
        region: conn.region,
      });
      const found = new Map<string, string>();
      let nextToken: string | undefined;
      do {
        const page = await cfn.send(
          new ListExportsCommand({ NextToken: nextToken })
        );
        for (const exp of page.Exports ?? []) {
          if (exp.Name && exp.Value) found.set(exp.Name, exp.Value);
        }
        nextToken = page.NextToken;
      } while (nextToken);

      const missing = Object.values(EXPORTS).filter((n) => !found.has(n));
      if (missing.length > 0) {
        return this.fail(
          workspaceId,
          `Role assumed OK, but the WithVibe stack's exports are missing in ${conn.region}: ${missing.join(", ")}. ` +
            "Deploy infra/aws/withvibe-client-compute.cfn.yaml in that region."
        );
      }

      const updated = await this.prisma.client.awsComputeConnection.update({
        where: { workspaceId },
        data: {
          clusterArn: found.get(EXPORTS.cluster),
          subnetIds: JSON.stringify(
            (found.get(EXPORTS.subnets) ?? "").split(",").filter(Boolean)
          ),
          securityGroupId: found.get(EXPORTS.securityGroup),
          logGroupName: found.get(EXPORTS.logGroup),
          taskExecutionRoleArn: found.get(EXPORTS.taskExecutionRole),
          taskRoleArn: found.get(EXPORTS.taskRole),
          status: "ok",
          lastError: null,
          lastVerifiedAt: new Date(),
        },
      });
      this.logger.info(
        `[aws-compute] workspace ${workspaceId} verified against ${conn.roleArn} (${conn.region})`
      );
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.fail(
        workspaceId,
        `Could not assume the role / read the stack: ${msg}`
      );
    }
  }

  /** Clears the account binding but keeps the externalId, so the client's
   * deployed stack stays valid if they reconnect later. */
  async disconnect(workspaceId: string): Promise<void> {
    const conn = await this.get(workspaceId);
    if (!conn) return;
    if (conn.roleArn && conn.region) {
      this.aws.evict({ roleArn: conn.roleArn, region: conn.region });
    }
    await this.prisma.client.awsComputeConnection.update({
      where: { workspaceId },
      data: {
        roleArn: null,
        region: null,
        clusterArn: null,
        subnetIds: null,
        securityGroupId: null,
        logGroupName: null,
        taskExecutionRoleArn: null,
        taskRoleArn: null,
        status: "pending",
        lastError: null,
        lastVerifiedAt: null,
      },
    });
  }

  private async fail(
    workspaceId: string,
    message: string
  ): Promise<AwsComputeConnection> {
    this.logger.warn(`[aws-compute] verify failed for ${workspaceId}: ${message}`);
    return this.prisma.client.awsComputeConnection.update({
      where: { workspaceId },
      data: { status: "error", lastError: message },
    });
  }
}
