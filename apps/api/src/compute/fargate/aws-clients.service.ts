import { Injectable } from "@nestjs/common";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { ECSClient } from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";

export type ClientAccountTarget = {
  roleArn: string;
  externalId: string;
  region: string;
};

/**
 * Builds AWS SDK clients scoped to a CLIENT account: every client here runs
 * with short-lived STS credentials from assuming the client's
 * withvibe-platform-access role (ExternalId-guarded). The platform's own
 * credentials come from the default Node provider chain (env vars
 * AWS_ACCESS_KEY_ID/SECRET on the api, or an instance profile) and are only
 * ever used for sts:AssumeRole + GetCallerIdentity.
 *
 * Clients are cached per (roleArn, region); `fromTemporaryCredentials`
 * auto-refreshes the session before expiry.
 */
@Injectable()
export class AwsClientsService {
  private readonly cache = new Map<
    string,
    {
      ecs: ECSClient;
      ec2: EC2Client;
      cfn: CloudFormationClient;
      logs: CloudWatchLogsClient;
    }
  >();
  private platformAccountId: string | null = null;

  /** The platform's own 12-digit account id — shown in the connect UI so the
   * client can fill the CloudFormation PlatformAccountId parameter. */
  async getPlatformAccountId(): Promise<string> {
    if (this.platformAccountId) return this.platformAccountId;
    const sts = new STSClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
    const res = await sts.send(new GetCallerIdentityCommand({}));
    if (!res.Account) {
      throw new Error("STS GetCallerIdentity returned no account id");
    }
    this.platformAccountId = res.Account;
    return res.Account;
  }

  /**
   * Probe the default provider chain with a real STS call — the only honest
   * way to know whether credentials exist, since the chain spans env vars,
   * ~/.aws/credentials profiles, and instance/container metadata. Returns
   * the platform account id, or null when no working credentials are found.
   */
  async platformIdentity(): Promise<string | null> {
    try {
      return await this.getPlatformAccountId();
    } catch {
      return null;
    }
  }

  private credentialsFor(
    target: ClientAccountTarget
  ): AwsCredentialIdentityProvider {
    return fromTemporaryCredentials({
      params: {
        RoleArn: target.roleArn,
        ExternalId: target.externalId,
        RoleSessionName: "withvibe-platform",
        DurationSeconds: 3600,
      },
      clientConfig: { region: target.region },
    });
  }

  clientsFor(target: ClientAccountTarget) {
    const key = `${target.roleArn}@${target.region}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const credentials = this.credentialsFor(target);
    const config = { region: target.region, credentials };
    const built = {
      ecs: new ECSClient(config),
      ec2: new EC2Client(config),
      cfn: new CloudFormationClient(config),
      logs: new CloudWatchLogsClient(config),
    };
    this.cache.set(key, built);
    return built;
  }

  /** Drop cached clients (after a disconnect / role change). */
  evict(target: Pick<ClientAccountTarget, "roleArn" | "region">) {
    this.cache.delete(`${target.roleArn}@${target.region}`);
  }
}
