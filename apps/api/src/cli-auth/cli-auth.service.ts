import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  CLI_AUTH_CODE_TTL_MS,
  generateCliAuthCode,
  generateCliToken,
} from "./cli-token.util";

export type InitiateResult = {
  code: string;
  expiresAt: string;
};

export type CodeStatus =
  | { status: "pending"; label: string | null }
  | { status: "confirmed"; token: string }
  | { status: "expired" };

@Injectable()
export class CliAuthService {
  constructor(private readonly prisma: PrismaService) {}

  async initiate(label: string | null): Promise<InitiateResult> {
    const code = generateCliAuthCode();
    const expiresAt = new Date(Date.now() + CLI_AUTH_CODE_TTL_MS);
    await this.prisma.client.cliAuthCode.create({
      data: { code, expiresAt, label },
    });
    return { code, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Look up a code for the consent UI. Doesn't consume — that's `poll`'s job
   * after `confirm` has fired.
   */
  async describe(code: string): Promise<{ label: string | null; expiresAt: string }> {
    const row = await this.prisma.client.cliAuthCode.findUnique({
      where: { code },
    });
    if (!row) throw new NotFoundException("Unknown code");
    if (row.expiresAt.getTime() < Date.now()) {
      throw new GoneException("Code expired");
    }
    if (row.confirmedAt) {
      throw new ConflictException("Code already used");
    }
    return { label: row.label, expiresAt: row.expiresAt.toISOString() };
  }

  /**
   * CLI polls here every ~2s. Returns the one-time secret on success and
   * clears it so a second poll can't pick it up.
   */
  async poll(code: string): Promise<CodeStatus> {
    const row = await this.prisma.client.cliAuthCode.findUnique({
      where: { code },
    });
    if (!row) return { status: "expired" };
    if (row.expiresAt.getTime() < Date.now()) return { status: "expired" };
    if (!row.confirmedAt) {
      return { status: "pending", label: row.label };
    }
    if (row.consumedAt || !row.deliverySecret) {
      return { status: "expired" };
    }

    const secret = row.deliverySecret;
    await this.prisma.client.cliAuthCode.update({
      where: { id: row.id },
      data: { consumedAt: new Date(), deliverySecret: null },
    });
    return { status: "confirmed", token: secret };
  }

  /**
   * Called by the browser after the signed-in user clicks "Approve". Mints
   * the CliToken + leaves the plaintext on the row for one-shot pickup by
   * the polling CLI.
   */
  async confirm(code: string, userId: string): Promise<void> {
    const codeRow = await this.prisma.client.cliAuthCode.findUnique({
      where: { code },
    });
    if (!codeRow) throw new NotFoundException("Unknown code");
    if (codeRow.expiresAt.getTime() < Date.now()) {
      throw new GoneException("Code expired");
    }
    if (codeRow.confirmedAt) {
      throw new ConflictException("Code already used");
    }

    const { secret, hash } = generateCliToken();
    const label =
      codeRow.label || `CLI device (${new Date().toISOString().slice(0, 10)})`;

    await this.prisma.client.$transaction(async (tx) => {
      await tx.cliToken.create({
        data: { userId, tokenHash: hash, label },
      });
      await tx.cliAuthCode.update({
        where: { id: codeRow.id },
        data: {
          userId,
          tokenHash: hash,
          deliverySecret: secret,
          confirmedAt: new Date(),
        },
      });
    });
  }
}
