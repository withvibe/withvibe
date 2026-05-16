import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
// DevOps-agent seeding has moved to the NestJS agents module and is called
// from there when a workspace is created. Keep base DB seeding here only.

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Seeding database...");

  const passwordHash = await bcrypt.hash("password123", 12);

  const admin = await prisma.user.upsert({
    where: { email: "admin@example.com" },
    update: {},
    create: {
      email: "admin@example.com",
      name: "Admin User",
      passwordHash,
      positions: ["tech_lead", "fullstack_engineer"],
      bio: "I own overall architecture and team coordination. Good at wearing many hats.",
    },
  });

  const backend = await prisma.user.upsert({
    where: { email: "backend@example.com" },
    update: {},
    create: {
      email: "backend@example.com",
      name: "Backend Engineer",
      passwordHash,
      positions: ["backend_engineer"],
      bio: "I build API endpoints, database schema, and integrations. Strong with NestJS and Postgres.",
    },
  });

  const frontend = await prisma.user.upsert({
    where: { email: "frontend@example.com" },
    update: {},
    create: {
      email: "frontend@example.com",
      name: "Frontend Engineer",
      passwordHash,
      positions: ["frontend_engineer"],
      bio: "I build UI, component library, and user flows. Work mostly in React + Next.js.",
    },
  });

  const workspace = await prisma.workspace.upsert({
    where: { id: "demo-workspace" },
    update: {},
    create: {
      id: "demo-workspace",
      name: "Demo R&D Team",
      description: "A demo workspace for WithVibe.",
    },
  });

  const members = [
    { userId: admin.id, role: "admin" as const },
    { userId: backend.id, role: "member" as const },
    { userId: frontend.id, role: "member" as const },
  ];

  for (const m of members) {
    await prisma.workspaceMember.upsert({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: m.userId },
      },
      update: { role: m.role },
      create: {
        workspaceId: workspace.id,
        userId: m.userId,
        role: m.role,
      },
    });
  }

  const env = await prisma.env.upsert({
    where: { id: "demo-env" },
    update: {},
    create: {
      id: "demo-env",
      workspaceId: workspace.id,
      title: "Add dark mode toggle",
      description:
        "Small sample env — a demo of how members collaborate with the AI on a single focused feature.",
      status: "todo",
      createdById: admin.id,
    },
  });

  await prisma.document.upsert({
    where: { envId: env.id },
    update: {},
    create: {
      envId: env.id,
      content: "",
    },
  });

  // NOTE: DevOps agent is seeded on workspace create by the NestJS agents
  // module. If you want it on the demo workspace too, hit the Nest API
  // endpoint that creates it (/api/workspaces/:id/agents/seed-defaults),
  // or re-run the seed via the Nest service once it's ported.

  console.log("Seed complete!");
  console.log("Demo accounts (all use password: password123):");
  console.log("  admin@example.com (workspace admin)");
  console.log("  backend@example.com (backend engineer)");
  console.log("  frontend@example.com (frontend engineer)");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
