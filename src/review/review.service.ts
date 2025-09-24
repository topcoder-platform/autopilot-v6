import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ReviewPrismaService } from './review-prisma.service';
import { AutopilotDbLoggerService } from '../autopilot/services/autopilot-db-logger.service';

interface SubmissionRecord {
  id: string;
}

interface ReviewRecord {
  submissionId: string | null;
  resourceId: string;
}

@Injectable()
export class ReviewService {
  private static readonly REVIEW_TABLE = Prisma.sql`"review"`;
  private static readonly SUBMISSION_TABLE = Prisma.sql`"submission"`;
  private static readonly REVIEW_SUMMATION_TABLE = Prisma.sql`"reviewSummation"`;

  constructor(
    private readonly prisma: ReviewPrismaService,
    private readonly dbLogger: AutopilotDbLoggerService,
  ) {}

  async getTopFinalReviewScores(
    challengeId: string,
    limit = 3,
  ): Promise<
    Array<{
      memberId: string;
      submissionId: string;
      aggregateScore: number;
    }>
  > {
    if (!challengeId) {
      return [];
    }

    const fetchLimit = Math.max(limit, 1) * 5;
    const limitClause = Prisma.sql`LIMIT ${fetchLimit}`;

    try {
      const rows = await this.prisma.$queryRaw<
        Array<{
          memberId: string | null;
          submissionId: string;
          aggregateScore: number | string | null;
        }>
      >(Prisma.sql`
        SELECT
          s."memberId" AS "memberId",
          s."id" AS "submissionId",
          rs."aggregateScore" AS "aggregateScore"
        FROM ${ReviewService.REVIEW_SUMMATION_TABLE} rs
        INNER JOIN ${ReviewService.SUBMISSION_TABLE} s
          ON s."id" = rs."submissionId"
        WHERE s."challengeId" = ${challengeId}
          AND rs."isFinal" = true
          AND rs."aggregateScore" IS NOT NULL
          AND s."memberId" IS NOT NULL
          AND (
            s."type" IS NULL
            OR upper(s."type") = 'CONTEST_SUBMISSION'
          )
        ORDER BY rs."aggregateScore" DESC, s."submittedDate" ASC, s."id" ASC
        ${limitClause}
      `);

      if (!rows.length) {
        void this.dbLogger.logAction('review.getTopFinalReviewScores', {
          challengeId,
          status: 'SUCCESS',
          source: ReviewService.name,
          details: { limit, rowsExamined: 0, winnersCount: 0 },
        });
        return [];
      }

      const seenMembers = new Set<string>();
      const winners: Array<{
        memberId: string;
        submissionId: string;
        aggregateScore: number;
      }> = [];

      for (const row of rows) {
        const memberId = row.memberId?.trim();
        if (!memberId || seenMembers.has(memberId)) {
          continue;
        }

        const aggregateScore =
          typeof row.aggregateScore === 'string'
            ? Number(row.aggregateScore)
            : (row.aggregateScore ?? 0);

        if (Number.isNaN(aggregateScore)) {
          continue;
        }

        winners.push({
          memberId,
          submissionId: row.submissionId,
          aggregateScore,
        });
        seenMembers.add(memberId);

        if (winners.length >= limit) {
          break;
        }
      }

      void this.dbLogger.logAction('review.getTopFinalReviewScores', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          limit,
          rowsExamined: rows.length,
          winnersCount: winners.length,
        },
      });

      return winners;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getTopFinalReviewScores', {
        challengeId,
        status: 'ERROR',
        source: ReviewService.name,
        details: { limit, error: err.message },
      });
      throw err;
    }
  }

  async getActiveSubmissionIds(challengeId: string): Promise<string[]> {
    const query = Prisma.sql`
      SELECT "id"
      FROM ${ReviewService.SUBMISSION_TABLE}
      WHERE "challengeId" = ${challengeId}
        AND ("status" = 'ACTIVE' OR "status" IS NULL)
    `;

    try {
      const submissions = await this.prisma.$queryRaw<SubmissionRecord[]>(query);
      const submissionIds = submissions.map((record) => record.id).filter(Boolean);

      void this.dbLogger.logAction('review.getActiveSubmissionIds', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: { submissionCount: submissionIds.length },
      });

      return submissionIds;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getActiveSubmissionIds', {
        challengeId,
        status: 'ERROR',
        source: ReviewService.name,
        details: { error: err.message },
      });
      throw err;
    }
  }

  async getExistingReviewPairs(
    phaseId: string,
    challengeId?: string,
  ): Promise<Set<string>> {
    const query = Prisma.sql`
      SELECT "submissionId", "resourceId"
      FROM ${ReviewService.REVIEW_TABLE}
      WHERE "phaseId" = ${phaseId}
    `;

    try {
      const existing = await this.prisma.$queryRaw<ReviewRecord[]>(query);
      const result = new Set<string>();

      for (const record of existing) {
        if (!record.submissionId) {
          continue;
        }
        result.add(this.composeKey(record.resourceId, record.submissionId));
      }

      void this.dbLogger.logAction('review.getExistingReviewPairs', {
        challengeId: challengeId ?? null,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          phaseId,
          pairCount: result.size,
        },
      });

      return result;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getExistingReviewPairs', {
        challengeId: challengeId ?? null,
        status: 'ERROR',
        source: ReviewService.name,
        details: {
          phaseId,
          error: err.message,
        },
      });
      throw err;
    }
  }

  async createPendingReview(
    submissionId: string,
    resourceId: string,
    phaseId: string,
    scorecardId: string,
    challengeId: string,
  ): Promise<void> {
    const insert = Prisma.sql`
      INSERT INTO ${ReviewService.REVIEW_TABLE} (
        "resourceId",
        "phaseId",
        "submissionId",
        "scorecardId",
        "status",
        "createdAt",
        "updatedAt"
      ) VALUES (
        ${resourceId},
        ${phaseId},
        ${submissionId},
        ${scorecardId},
        'PENDING',
        NOW(),
        NOW()
      )
    `;

    try {
      await this.prisma.$executeRaw(insert);

      void this.dbLogger.logAction('review.createPendingReview', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          resourceId,
          submissionId,
          phaseId,
        },
      });
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.createPendingReview', {
        challengeId,
        status: 'ERROR',
        source: ReviewService.name,
        details: {
          resourceId,
          submissionId,
          phaseId,
          error: err.message,
        },
      });
      throw err;
    }
  }

  private composeKey(resourceId: string, submissionId: string): string {
    return `${resourceId}:${submissionId}`;
  }
}
