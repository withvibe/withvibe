import { Injectable } from "@nestjs/common";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { ECSClient } from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { EFSClient } from "@aws-sdk/client-efs";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";

/**
 * Cache-key separator. NUL, because it cannot occur in an ARN, an external
 * id or a region name — so no value can be crafted to collide with a
 * different triple. Named rather than inlined: a bare control character in
 * source is invisible, and this one has to match the split in `evict`.
 */
const KEY_SEP = "\u0000";

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
 * Clients are cached per (roleArn, externalId, region); `fromTemporaryCredentials`
 * auto-refreshes the session before expiry.
 *
 * The externalId belongs in that key even though it never varies for a given
 * role in practice. The CloudFormation template gives every client the same
 * role *name*, so two workspaces pointing at one AWS account produce an
 * identical roleArn while holding different external ids — and the stack
 * trusts exactly one of them. Keyed without it, whichever workspace built its
 * clients first lent its credentials to all the others, so a single workspace
 * with a stale external id turned every workspace's AWS call into an
 * AccessDenied until the api restarted.
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
      efs: EFSClient;
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

  private cacheKey(target: ClientAccountTarget): string {
    return [target.roleArn, target.externalId, target.region].join(KEY_SEP);
  }

  clientsFor(target: ClientAccountTarget) {
    const key = this.cacheKey(target);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const credentials = this.credentialsFor(target);
    const config = { region: target.region, credentials };
    const built = {
      ecs: new ECSClient(config),
      ec2: new EC2Client(config),
      cfn: new CloudFormationClient(config),
      logs: new CloudWatchLogsClient(config),
      efs: new EFSClient(config),
    };
    this.cache.set(key, built);
    return built;
  }

  /**
   * Drop cached clients (after a disconnect / role change).
   *
   * Every external id for this role and region goes, not just the current one:
   * the caller is telling us the binding changed, and the entry worth dropping
   * is precisely the one keyed by the id that is no longer in use.
   */
  evict(target: Pick<ClientAccountTarget, "roleArn" | "region">) {
    for (const key of [...this.cache.keys()]) {
      const [roleArn, , region] = key.split(KEY_SEP);
      if (roleArn === target.roleArn && region === target.region) {
        this.cache.delete(key);
      }
    }
  }
}
