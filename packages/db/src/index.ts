import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Singleton Prisma client for the monorepo.
 *
 * Uses Node's global to reuse the same instance across Next.js HMR reloads
 * in dev (standard pattern — otherwise you exhaust DB connections).
 */

const globalForPrisma = globalThis as unknown as {
  prisma: InstanceType<typeof PrismaClient> | undefined;
};

function createPrismaClient() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const adapter = new PrismaPg(url);
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// Re-export types from the generated client so consumers can do:
//   import type { User, Workspace, WorkspaceRole } from "@withvibe/db";
export * from "../generated/prisma/models.js";
export * from "../generated/prisma/enums.js";
export { PrismaClient, Prisma } from "../generated/prisma/client.js";
export * from "./profile-constants.js";
export * from "./user-display.js";
