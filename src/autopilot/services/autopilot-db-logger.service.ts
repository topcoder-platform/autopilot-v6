import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AutopilotPrismaService } from './autopilot-prisma.service';

export interface AutopilotDbLogPayload {
  challengeId?: string | null;
  source?: string;
  status?: 'SUCCESS' | 'ERROR' | 'INFO';
  details?: Record<string, unknown> | Array<unknown> | null;
}

@Injectable()
export class AutopilotDbLoggerService {
  private readonly logger = new Logger(AutopilotDbLoggerService.name);
  private readonly dbDebugEnabled: boolean;
  private schemaReady = false;
  private initializing?: Promise<void>;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: AutopilotPrismaService,
  ) {
    this.dbDebugEnabled =
      this.configService.get<boolean>('autopilot.dbDebug') ?? false;
  }

  async logAction(
    action: string,
    payload: AutopilotDbLogPayload = {},
  ): Promise<void> {
    if (!this.dbDebugEnabled) {
      return;
    }

    const databaseUrl = this.configService.get<string>('autopilot.dbUrl');
    if (!databaseUrl) {
      this.logger.warn(
        `DB_DEBUG is enabled but AUTOPILOT_DB_URL is not configured. Skipping DB debug log for action "${action}".`,
      );
      return;
    }

    try {
      await this.ensureSchema();
    } catch (error) {
      const err = error as Error;
      this.logger.warn(
        `Failed to ensure autopilot debug schema while logging action "${action}": ${err.message}`,
      );
      return;
    }

    const { challengeId = null, source, status = 'SUCCESS', details } = payload;
    const serializedDetails =
      details === undefined || details === null ? null : JSON.stringify(details);

    try {
      await this.prisma.$executeRaw(
        Prisma.sql`
          INSERT INTO "autopilot"."actions" (
            "id",
            "challengeId",
            "action",
            "status",
            "source",
            "details",
            "createdAt"
          ) VALUES (
            ${randomUUID()},
            ${challengeId},
            ${action},
            ${status},
            ${source ?? null},
            ${serializedDetails},
            NOW()
          )
        `,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.warn(
        `Failed to write DB debug action "${action}": ${err.message}`,
      );
    }
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) {
      return;
    }

    if (!this.initializing) {
      this.initializing = this.initializeSchema();
    }

    await this.initializing;
  }

  private async initializeSchema(): Promise<void> {
    try {
      await this.prisma.$executeRaw(
        Prisma.sql`CREATE SCHEMA IF NOT EXISTS "autopilot"`
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

      await this.prisma.$executeRaw(
        Prisma.sql`
          CREATE INDEX IF NOT EXISTS "idx_autopilot_actions_challenge"
            ON "autopilot"."actions" ("challengeId")
        `,
      );

      this.schemaReady = true;
    } finally {
      this.initializing = undefined;
    }
  }
}
