import "../src/lib/load-env";

import { prisma } from "../src/server/db";
import { hashPassword } from "../src/server/security/crypto";

/**
 * Creates exactly one operator account, and nothing else.
 *
 * This is deliberately NOT `prisma/seed.ts`. That script builds a 719-line
 * demonstration dataset — projects, posts, publish jobs, analytics snapshots,
 * experiments — which is the right thing for a laptop and completely wrong for
 * production. Running it against a real database would fabricate an operating
 * history that never happened, which is the exact failure this deployment has
 * just spent a day climbing out of.
 *
 * So: one workspace (a Project cannot exist without one), one user, no content.
 * Everything else is created by using the product.
 *
 *   DATABASE_URL=<production url> \
 *   OPERATOR_EMAIL=you@example.com \
 *   OPERATOR_PASSWORD=<a real password> \
 *   npx tsx prisma/create-operator.ts
 *
 * Idempotent: re-running updates the password and leaves everything else alone.
 * It never deletes.
 */

const MIN_PASSWORD_LENGTH = 12;

async function main(): Promise<void> {
  const email = process.env.OPERATOR_EMAIL?.trim().toLowerCase();
  const password = process.env.OPERATOR_PASSWORD;
  const name = process.env.OPERATOR_NAME?.trim() || "Operator";

  if (!email) {
    throw new Error("Set OPERATOR_EMAIL to the address you want to sign in with.");
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Set OPERATOR_PASSWORD to at least ${MIN_PASSWORD_LENGTH} characters. This account can publish to real social accounts.`,
    );
  }

  const target = new URL(process.env.DATABASE_URL ?? "postgresql://unset/unset");
  // The host, never the credentials — this output may end up in a terminal log.
  console.log(`database: ${target.hostname}${target.pathname}`);

  const workspace =
    (await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } })) ??
    (await prisma.workspace.create({
      data: { slug: "social-scales", name: "Social Scales" },
    }));
  console.log(`workspace: ${workspace.name} (${workspace.id})`);

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, name, passwordHash },
    update: { passwordHash, name },
  });
  console.log(`operator:  ${user.email} (${user.id})`);

  // Prove nothing else was invented.
  const [projects, posts, accounts, snapshots] = await Promise.all([
    prisma.project.count(),
    prisma.post.count(),
    prisma.socialAccount.count(),
    prisma.analyticsSnapshot.count(),
  ]);
  console.log(
    `content after bootstrap: projects=${projects} posts=${posts} socialAccounts=${accounts} analyticsSnapshots=${snapshots}`,
  );
  console.log("Sign in at /login, then create a project from /ops/projects.");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
