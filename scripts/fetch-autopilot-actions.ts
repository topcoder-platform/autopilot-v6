import { Prisma, PrismaClient } from '@prisma/client';

interface AutopilotActionRecord {
  id: string;
  challengeId: string | null;
  action: string;
  status: string;
  source: string | null;
  details: Prisma.JsonValue | null;
  createdAt: Date | string;
}

async function main(): Promise<void> {
  const [, , challengeId] = process.argv;

  if (!challengeId) {
    console.error('Usage: ts-node scripts/fetch-autopilot-actions.ts <challengeId>');
    process.exit(1);
  }

  const databaseUrl = process.env.AUTOPILOT_DB_URL;

  if (!databaseUrl) {
    console.error('AUTOPILOT_DB_URL environment variable is not set.');
    process.exit(1);
  }

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
  });

  try {
    const rows = (await prisma.$queryRaw<AutopilotActionRecord[]>
      (Prisma.sql`
        SELECT
          "id",
          "challengeId",
          "action",
          "status",
          "source",
          "details",
          "createdAt"
        FROM "autopilot"."actions"
        WHERE "challengeId" = ${challengeId}
        ORDER BY "createdAt" ASC
      `)) ?? [];

    const normalizedRows = rows.map((row) => ({
      ...row,
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : row.createdAt,
    }));

    console.log(JSON.stringify(normalizedRows, null, 2));
  } catch (error) {
    const err = error as Error;
    console.error(`Failed to fetch autopilot actions: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
