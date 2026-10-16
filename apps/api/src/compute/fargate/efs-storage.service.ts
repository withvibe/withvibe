import { Injectable } from "@nestjs/common";
import {
  CreateAccessPointCommand,
  DeleteAccessPointCommand,
  DescribeAccessPointsCommand,
  type AccessPointDescription,
} from "@aws-sdk/client-efs";
import type { AwsComputeConnectionModel as AwsComputeConnection } from "@withvibe/db";
import { AwsClientsService } from "./aws-clients.service";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

/**
 * Persistent storage for Fargate environments.
 *
 * A plain Fargate task volume is scratch space: it is created with the task and
 * destroyed with it, so stopping an environment — including automatically, when
 * it goes idle — loses whatever the services wrote. That is survivable while a
 * sandbox holds nothing but a demo database, and unacceptable the moment it
 * holds a user's work.
 *
 * The filesystem is shared by the whole cluster, so isolation comes from EFS
 * access points rather than from separate filesystems: each (env, volume) pair
 * gets an access point that pins its own subdirectory AND a POSIX identity, so
 * a task physically cannot read another environment's files even though it
 * mounts the same filesystem. The task role's permission is in turn
 * conditioned on going through an access point, so a task cannot bypass one.
 */
@Injectable()
export class EfsStorageService {
  constructor(
    @InjectPinoLogger(EfsStorageService.name)
    private readonly logger: PinoLogger,
    private readonly aws: AwsClientsService
  ) {}

  /**
   * Access point id for one env volume, creating it on first use.
   *
   * Idempotent by tag rather than by name: AWS has no unique-name constraint on
   * access points, so a create-if-missing has to look first. Returns null when
   * the client's stack predates EFS, which leaves the volume ephemeral instead
   * of failing the start.
   */
  async ensureAccessPoint(
    conn: AwsComputeConnection,
    envId: string,
    volume: string,
    /**
     * Directory the access point pins, defaulting to this volume's own. Repo
     * bind mounts override it to point *inside* the workspace volume, so a
     * service container can mount one repository's clone without being handed
     * the whole workspace.
     */
    rootPath = `/${envId}/${volume}`
  ): Promise<string | null> {
    if (!conn.fileSystemId) return null;
    const { efs } = this.aws.clientsFor({
      roleArn: conn.roleArn!,
      externalId: conn.externalId,
      region: conn.region!,
    });

    const existing = await this.findAccessPoint(conn, envId, volume);
    if (existing) return existing;

    const created = await efs.send(
      new CreateAccessPointCommand({
        FileSystemId: conn.fileSystemId,
        // Tags are the lookup key — see findAccessPoint.
        Tags: [
          { Key: "withvibe-env", Value: envId },
          { Key: "withvibe-volume", Value: volume },
          { Key: "Name", Value: `wv-${envId}-${volume}` },
        ],
        // uid/gid 0: container images run their daemons as assorted users
        // (postgres=999, mysql=999, redis=999…) and an access point forces ONE
        // identity on every file. Root is the only one that works for all of
        // them; the directory is still private to this access point.
        PosixUser: { Uid: 0, Gid: 0 },
        RootDirectory: {
          Path: rootPath,
          // EFS only creates the path if CreationInfo is present.
          CreationInfo: {
            OwnerUid: 0,
            OwnerGid: 0,
            Permissions: "0755",
          },
        },
      })
    );
    this.logger.info(
      `[efs] created access point ${created.AccessPointId} for env ${envId} volume ${volume}`
    );
    return created.AccessPointId ?? null;
  }

  /** Delete every access point belonging to an env. Best-effort. */
  async deleteForEnv(
    conn: AwsComputeConnection,
    envId: string
  ): Promise<number> {
    if (!conn.fileSystemId) return 0;
    const { efs } = this.aws.clientsFor({
      roleArn: conn.roleArn!,
      externalId: conn.externalId,
      region: conn.region!,
    });
    const points = await this.listForFileSystem(conn);
    const mine = points.filter(
      (p) => tagOf(p.Tags, "withvibe-env") === envId && p.AccessPointId
    );
    let deleted = 0;
    for (const p of mine) {
      try {
        await efs.send(
          new DeleteAccessPointCommand({ AccessPointId: p.AccessPointId! })
        );
        deleted++;
      } catch (err) {
        // The data outlives a failed delete, which costs storage but never
        // breaks a start — log and move on rather than failing the teardown.
        this.logger.warn(
          `[efs] could not delete access point ${p.AccessPointId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    if (deleted > 0) {
      this.logger.info(`[efs] deleted ${deleted} access point(s) for env ${envId}`);
    }
    return deleted;
  }

  private async findAccessPoint(
    conn: AwsComputeConnection,
    envId: string,
    volume: string
  ): Promise<string | null> {
    const points = await this.listForFileSystem(conn);
    const hit = points.find(
      (p) =>
        tagOf(p.Tags, "withvibe-env") === envId &&
        tagOf(p.Tags, "withvibe-volume") === volume
    );
    return hit?.AccessPointId ?? null;
  }

  private async listForFileSystem(conn: AwsComputeConnection) {
    const { efs } = this.aws.clientsFor({
      roleArn: conn.roleArn!,
      externalId: conn.externalId,
      region: conn.region!,
    });
    const out: AccessPointDescription[] = [];
    let token: string | undefined;
    do {
      const page = await efs.send(
        new DescribeAccessPointsCommand({
          FileSystemId: conn.fileSystemId!,
          NextToken: token,
        })
      );
      out.push(...(page.AccessPoints ?? []));
      token = page.NextToken;
    } while (token);
    return out;
  }
}

function tagOf(
  tags: { Key?: string; Value?: string }[] | undefined,
  key: string
): string | null {
  return tags?.find((t) => t.Key === key)?.Value ?? null;
}
