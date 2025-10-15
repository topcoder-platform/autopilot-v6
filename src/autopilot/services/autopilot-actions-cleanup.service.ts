import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { AutopilotPrismaService } from './autopilot-prisma.service';

@Injectable()
export class AutopilotActionsCleanupService {
  private readonly logger = new Logger(AutopilotActionsCleanupService.name);
  private readonly dbDebugEnabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: AutopilotPrismaService,
  ) {
    this.dbDebugEnabled =
      this.configService.get<boolean>('autopilot.dbDebug') ?? false;
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async purgeOldActions(): Promise<void> {
    if (!this.dbDebugEnabled) {
      return;
    }

    const databaseUrl = this.configService.get<string>('autopilot.dbUrl');
    if (!databaseUrl) {
      this.logger.warn(
        'Skipping autopilot action cleanup because AUTOPILOT_DB_URL is not configured.',
      );
      return;
    }

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 2);

    try {
      await this.ensureSchema();

      const deletedCount = await this.prisma.$executeRaw<number>(
        Prisma.sql`
          DELETE FROM "autopilot"."actions"
          WHERE "createdAt" < ${cutoff}
        `,
      );

      if (deletedCount > 0) {
        this.logger.log(
          `Removed ${deletedCount} autopilot action records older than ${cutoff.toISOString()}.`,
        );
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to purge autopilot actions older than ${cutoff.toISOString()}: ${err.message}`,
        err.stack,
      );
    }
  }

  private async ensureSchema(): Promise<void> {
    await this.prisma.$executeRaw(
      Prisma.sql`CREATE SCHEMA IF NOT EXISTS "autopilot"`,
    );

    await this.prisma.$executeRaw(
      Prisma.sql`
        CREATE TABLE IF NOT EXISTS "autopilot"."actions" (
          "id" UUID PRIMARY KEY,
          "challengeId" TEXT NULL,
          "action" TEXT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'SUCCESS',
          "source" TEXT NULL,
          "details" JSONB NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
    );
  }
}
