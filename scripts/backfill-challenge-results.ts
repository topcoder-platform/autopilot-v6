import {
  ChallengeStatusEnum,
  PrismaClient,
  PrizeSetTypeEnum,
} from '@prisma/client';
import { ReviewService } from '../src/review/review.service';
import {
  challengeAllowsUnlimitedSubmissions,
  isRatedChallenge,
} from '../src/autopilot/utils/challenge-metadata.utils';

interface CliOptions {
  challengeIds: string[];
  concurrency: number;
  dryRun: boolean;
  limit: number | null;
  updatedSince: Date | null;
}

/**
 * Parse command-line arguments for the challenge-result backfill.
 * @param argv Raw CLI arguments excluding the Node and script paths.
 * @returns Normalized script options.
 * @throws Error when an argument is malformed.
 */
function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    challengeIds: [],
    concurrency: 5,
    dryRun: false,
    limit: null,
    updatedSince: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--challengeId') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--challengeId requires a value');
      }
      options.challengeIds.push(...splitCsv(value));
      index += 1;
      continue;
    }

    if (arg === '--limit') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--limit must be a positive number');
      }
      options.limit = Math.floor(value);
      index += 1;
      continue;
    }

    if (arg === '--concurrency') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--concurrency must be a positive number');
      }
      options.concurrency = Math.floor(value);
      index += 1;
      continue;
    }

    if (arg === '--updated-since') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--updated-since requires an ISO timestamp');
      }
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error('--updated-since must be a valid ISO timestamp');
      }
      options.updatedSince = parsed;
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  options.challengeIds = Array.from(new Set(options.challengeIds));
  return options;
}

/**
 * Split a comma-delimited argument into trimmed tokens.
 * @param value Raw CLI value.
 * @returns Non-empty tokens.
 * @throws Never.
 */
function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Print command usage for the backfill script.
 * @returns Never.
 * @throws Never.
 */
function printUsage(): void {
  console.log(`Usage: tsx scripts/backfill-challenge-results.ts [options]

Options:
  --challengeId <id[,id...]>   Restrict the run to one or more challenge ids.
  --updated-since <iso>        Only process completed challenges updated on/after the timestamp.
  --limit <n>                  Maximum number of challenges to process.
  --concurrency <n>            Parallel challenge workers. Default: 5.
  --dry-run                    Build rows without writing to reviews.challengeResult.
  --help                       Show this message.
`);
}

/**
 * Ensure the required database URLs exist before the script starts.
 * @returns Never.
 * @throws Error when a required environment variable is missing.
 */
function validateEnvironment(): void {
  if (!process.env.CHALLENGE_DB_URL) {
    throw new Error('CHALLENGE_DB_URL is required');
  }
  if (!process.env.REVIEW_DB_URL) {
    throw new Error('REVIEW_DB_URL is required');
  }
}

/**
 * Resolve the timestamp used when creating new `challengeResult` rows.
 * @param challenge Completed challenge row from challenge DB.
 * @returns Best-effort completion timestamp.
 * @throws Never.
 */
function resolveCreatedAt(challenge: {
  endDate: Date | null;
  updatedAt: Date;
  createdAt: Date;
}): Date {
  return challenge.endDate ?? challenge.updatedAt ?? challenge.createdAt;
}

/**
 * Run an async worker across a list with bounded parallelism.
 * @param items Items to process.
 * @param concurrency Maximum parallel workers.
 * @param worker Async worker invoked for each item.
 * @returns Worker results in input order.
 * @throws Error when a worker throws.
 */
async function mapWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  worker: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  const runners = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= items.length) {
          return;
        }

        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    },
  );

  await Promise.all(runners);
  return results;
}

/**
 * Backfill or preview challenge-result rows for the selected completed challenges.
 * @returns Promise resolved when processing is complete.
 * @throws Error when database access or row building fails.
 */
async function main(): Promise<void> {
  validateEnvironment();
  const options = parseArgs(process.argv.slice(2));

  const challengeClient = new PrismaClient({
    datasources: {
      db: {
        url: process.env.CHALLENGE_DB_URL,
      },
    },
  });
  const reviewClient = new PrismaClient({
    datasources: {
      db: {
        url: process.env.REVIEW_DB_URL,
      },
    },
  });

  const reviewService = new ReviewService(
    reviewClient as unknown as any,
    { logAction: async () => undefined } as any,
  );

  try {
    const challenges = await challengeClient.challenge.findMany({
      where: {
        status: ChallengeStatusEnum.COMPLETED,
        numOfSubmissions: {
          gt: 0,
        },
        ...(options.challengeIds.length
          ? {
              id: {
                in: options.challengeIds,
              },
            }
          : {}),
        ...(options.updatedSince
          ? {
              updatedAt: {
                gte: options.updatedSince,
              },
            }
          : {}),
      },
      orderBy: {
        updatedAt: 'asc',
      },
      ...(options.limit ? { take: options.limit } : {}),
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        endDate: true,
        metadata: {
          select: {
            name: true,
            value: true,
          },
        },
        winners: {
          select: {
            userId: true,
            placement: true,
            type: true,
          },
        },
      },
    });

    if (!challenges.length) {
      console.log('No completed challenges matched the selection.');
      return;
    }

    console.log(
      `Processing ${challenges.length} completed challenge(s)${options.dryRun ? ' in dry-run mode' : ''}.`,
    );

    let totalRowsBuilt = 0;
    let totalRowsUpserted = 0;
    let totalRowsDeleted = 0;

    await mapWithConcurrency(
      challenges,
      options.concurrency,
      async (challenge, index) => {
        const metadata = Object.fromEntries(
          challenge.metadata.map((entry) => [entry.name, entry.value]),
        );
        const placementWinners = challenge.winners
          .filter((winner) => winner.type === PrizeSetTypeEnum.PLACEMENT)
          .map((winner) => ({
            userId: winner.userId,
            placement: winner.placement,
          }));
        const allowUnlimitedSubmissions = challengeAllowsUnlimitedSubmissions(
          {
            id: challenge.id,
            metadata,
          },
          (message) => console.warn(`[${challenge.id}] ${message}`),
        );
        const ratedChallenge = isRatedChallenge({ metadata });
        const createdAt = resolveCreatedAt(challenge);

        if (options.dryRun) {
          const rows =
            await reviewService.buildChallengeResultRecordsForChallenge(
              challenge.id,
              {
                placementWinners,
                allowUnlimitedSubmissions,
                ratedChallenge,
                actor: 'autopilot-challenge-result-backfill',
                createdAt,
                updatedAt: new Date(),
              },
            );

          totalRowsBuilt += rows.length;
          console.log(
            `[${index + 1}/${challenges.length}] ${challenge.id} dry-run rowsBuilt=${rows.length}`,
          );
          return;
        }

        const result = await reviewService.syncChallengeResultsForChallenge(
          challenge.id,
          {
            placementWinners,
            allowUnlimitedSubmissions,
            ratedChallenge,
            actor: 'autopilot-challenge-result-backfill',
            createdAt,
            updatedAt: new Date(),
          },
        );

        totalRowsBuilt += result.rowsBuilt;
        totalRowsUpserted += result.rowsUpserted;
        totalRowsDeleted += result.staleRowsDeleted;

        console.log(
          `[${index + 1}/${challenges.length}] ${challenge.id} rowsBuilt=${result.rowsBuilt} rowsUpserted=${result.rowsUpserted} staleRowsDeleted=${result.staleRowsDeleted}`,
        );
      },
    );

    console.log(
      options.dryRun
        ? `Dry run complete. rowsBuilt=${totalRowsBuilt}`
        : `Backfill complete. rowsBuilt=${totalRowsBuilt} rowsUpserted=${totalRowsUpserted} staleRowsDeleted=${totalRowsDeleted}`,
    );
  } finally {
    await Promise.all([challengeClient.$disconnect(), reviewClient.$disconnect()]);
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
