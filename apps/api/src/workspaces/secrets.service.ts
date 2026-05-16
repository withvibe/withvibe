import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const MAX_NAME_LEN = 128;
const MAX_VALUE_LEN = 64 * 1024;

function normalizeName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new BadRequestException("Secret name is required");
  }
  const name = raw.trim();
  if (name.length > MAX_NAME_LEN) {
    throw new BadRequestException(`Secret name too long (max ${MAX_NAME_LEN})`);
  }
  if (!NAME_RE.test(name)) {
    throw new BadRequestException(
      "Secret name must be UPPER_SNAKE_CASE starting with a letter"
    );
  }
  return name;
}

function normalizeValue(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new BadRequestException("Secret value must be a string");
  }
  if (raw.length > MAX_VALUE_LEN) {
    throw new BadRequestException(
      `Secret value too long (max ${MAX_VALUE_LEN} chars)`
    );
  }
  return raw;
}

@Injectable()
export class SecretsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService
  ) {}

  /**
   * Lists secret names + timestamps for the workspace. Values are NEVER
   * returned through the API surface — they only flow into materialization.
   */
  async list(userId: string, workspaceId: string) {
    await this.access.member(userId, workspaceId);
    return this.prisma.client.workspaceSecret.findMany({
      where: { workspaceId },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
      orderBy: { name: "asc" },
    });
  }

  async upsert(
    userId: string,
    workspaceId: string,
    body: { name?: unknown; value?: unknown }
  ) {
    await this.access.admin(userId, workspaceId);
    const name = normalizeName(body.name);
    const value = normalizeValue(body.value);
    const row = await this.prisma.client.workspaceSecret.upsert({
      where: { workspaceId_name: { workspaceId, name } },
      create: { workspaceId, name, value },
      update: { value },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });
    return row;
  }

  async update(
    userId: string,
    workspaceId: string,
    name: string,
    body: { value?: unknown }
  ) {
    await this.access.admin(userId, workspaceId);
    const safeName = normalizeName(name);
    const value = normalizeValue(body.value);
    const existing = await this.prisma.client.workspaceSecret.findUnique({
      where: { workspaceId_name: { workspaceId, name: safeName } },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException("Secret not found");
    const row = await this.prisma.client.workspaceSecret.update({
      where: { id: existing.id },
      data: { value },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });
    return row;
  }

  async delete(userId: string, workspaceId: string, name: string) {
    await this.access.admin(userId, workspaceId);
    const safeName = normalizeName(name);
    const existing = await this.prisma.client.workspaceSecret.findUnique({
      where: { workspaceId_name: { workspaceId, name: safeName } },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException("Secret not found");
    await this.prisma.client.workspaceSecret.delete({
      where: { id: existing.id },
    });
    return { ok: true };
  }

  /**
   * Internal: load all secrets for a workspace as a name→value map.
   * Used by the template materializer — bypasses access checks since
   * materialization runs in a trusted context.
   */
  async loadForMaterialization(
    workspaceId: string
  ): Promise<Record<string, string>> {
    const rows = await this.prisma.client.workspaceSecret.findMany({
      where: { workspaceId },
      select: { name: true, value: true },
    });
    const out: Record<string, string> = {};
    for (const r of rows) out[r.name] = r.value;
    return out;
  }
}
