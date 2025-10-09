import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
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

interface PendingCountRecord {
  count: number | string;
}

interface ReviewDetailRecord {
  id: string;
  phaseId: string | null;
  resourceId: string;
  submissionId: string | null;
  scorecardId: string | null;
  score: number | string | null;
  status: string | null;
}

interface ScorecardRecord {
  minimumPassingScore: number | string | null;
}

interface AppealCountRecord {
  count: number | string;
}

interface SubmissionAggregationRecord {
  submissionId: string;
  legacySubmissionId: string | null;
  memberId: string | null;
  submittedDate: Date | null;
  aggregateScore: number | string | null;
  scorecardId: string | null;
  scorecardLegacyId: string | null;
  minimumPassingScore: number | string | null;
}

export interface SubmissionSummary {
  submissionId: string;
  legacySubmissionId: string | null;
  memberId: string | null;
  submittedDate: Date | null;
  aggregateScore: number;
  scorecardId: string | null;
  scorecardLegacyId: string | null;
  passingScore: number;
  isPassing: boolean;
}

@Injectable()
export class ReviewService {
  private static readonly REVIEW_TABLE = Prisma.sql`"review"`;
  private static readonly SUBMISSION_TABLE = Prisma.sql`"submission"`;
  private static readonly REVIEW_SUMMATION_TABLE = Prisma.sql`"reviewSummation"`;
  private static readonly SCORECARD_TABLE = Prisma.sql`"scorecard"`;
  private static readonly APPEAL_TABLE = Prisma.sql`"appeal"`;
  private static readonly APPEAL_RESPONSE_TABLE = Prisma.sql`"appealResponse"`;
  private static readonly REVIEW_ITEM_COMMENT_TABLE = Prisma.sql`"reviewItemComment"`;
  private static readonly REVIEW_ITEM_TABLE = Prisma.sql`"reviewItem"`;

  constructor(
    private readonly prisma: ReviewPrismaService,
    private readonly dbLogger: AutopilotDbLoggerService,
  ) {}

  private resolvePassingScore(
    value: number | string | null | undefined,
  ): number {
    if (value === null || value === undefined) {
      return 50;
    }

    const numericValue =
      typeof value === 'number' ? value : Number(value);

    return Number.isFinite(numericValue) ? numericValue : 50;
  }

  private buildPendingReviewLockId(
    phaseId: string,
    resourceId: string,
    submissionId: string | null,
    scorecardId: string | null,
  ): bigint {
    const key = [
      phaseId?.trim() ?? '',
      resourceId?.trim() ?? '',
      submissionId?.trim() ?? 'null',
      scorecardId?.trim() ?? 'null',
    ].join('|');

    const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);

    return BigInt.asIntN(64, BigInt(`0x${hash || '0'}`));
  }

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
            OR UPPER((s."type")::text) = 'CONTEST_SUBMISSION'
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
      const submissions =
        await this.prisma.$queryRaw<SubmissionRecord[]>(query);
      const submissionIds = submissions
        .map((record) => record.id)
        .filter(Boolean);

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

  async getActiveContestSubmissionIds(
    challengeId: string,
  ): Promise<string[]> {
    const query = Prisma.sql`
      SELECT "id"
      FROM ${ReviewService.SUBMISSION_TABLE}
      WHERE "challengeId" = ${challengeId}
        AND ("status" = 'ACTIVE' OR "status" IS NULL)
        AND (
          "type" IS NULL
          OR UPPER(("type")::text) = 'CONTEST_SUBMISSION'
        )
    `;

    try {
      const submissions =
        await this.prisma.$queryRaw<SubmissionRecord[]>(query);
      const submissionIds = submissions
        .map((record) => record.id)
        .filter(Boolean);

      void this.dbLogger.logAction('review.getActiveContestSubmissionIds', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: { submissionCount: submissionIds.length },
      });

      return submissionIds;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getActiveContestSubmissionIds', {
        challengeId,
        status: 'ERROR',
        source: ReviewService.name,
        details: { error: err.message },
      });
      throw err;
    }
  }

  async getActiveCheckpointSubmissionIds(
    challengeId: string,
  ): Promise<string[]> {
    const query = Prisma.sql`
      SELECT "id"
      FROM ${ReviewService.SUBMISSION_TABLE}
      WHERE "challengeId" = ${challengeId}
        AND ("status" = 'ACTIVE' OR "status" IS NULL)
        AND UPPER(("type")::text) = 'CHECKPOINT_SUBMISSION'
    `;

    try {
      const submissions =
        await this.prisma.$queryRaw<SubmissionRecord[]>(query);
      const submissionIds = submissions
        .map((record) => record.id)
        .filter(Boolean);

      void this.dbLogger.logAction(
        'review.getActiveCheckpointSubmissionIds',
        {
          challengeId,
          status: 'SUCCESS',
          source: ReviewService.name,
          details: { submissionCount: submissionIds.length },
        },
      );

      return submissionIds;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction(
        'review.getActiveCheckpointSubmissionIds',
        {
          challengeId,
          status: 'ERROR',
          source: ReviewService.name,
          details: { error: err.message },
        },
      );
      throw err;
    }
  }

  /**
   * Returns checkpoint submission IDs that have a COMPLETED review for the provided screening scorecard
   * with a final score greater than or equal to the scorecard's minimumPassingScore.
   */
  async getCheckpointPassedSubmissionIds(
    challengeId: string,
    screeningScorecardId: string,
  ): Promise<string[]> {
    if (!challengeId || !screeningScorecardId) {
      return [];
    }

    const query = Prisma.sql`
      SELECT s."id"
      FROM ${ReviewService.SUBMISSION_TABLE} s
      INNER JOIN ${ReviewService.REVIEW_TABLE} r
        ON r."submissionId" = s."id"
      INNER JOIN ${ReviewService.SCORECARD_TABLE} sc
        ON sc."id" = r."scorecardId"
      WHERE s."challengeId" = ${challengeId}
        AND (s."status" = 'ACTIVE' OR s."status" IS NULL)
        AND UPPER((s."type")::text) = 'CHECKPOINT_SUBMISSION'
        AND r."scorecardId" = ${screeningScorecardId}
        AND UPPER((r."status")::text) = 'COMPLETED'
        AND COALESCE(r."finalScore", 0) >= COALESCE(sc."minimumPassingScore", 50)
    `;

    try {
      const rows = await this.prisma.$queryRaw<SubmissionRecord[]>(query);
      const submissionIds = rows.map((r) => r.id).filter(Boolean);

      void this.dbLogger.logAction('review.getCheckpointPassedSubmissionIds', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          screeningScorecardId,
          submissionCount: submissionIds.length,
        },
      });

      return submissionIds;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getCheckpointPassedSubmissionIds', {
        challengeId,
        status: 'ERROR',
        source: ReviewService.name,
        details: {
          screeningScorecardId,
          error: err.message,
        },
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
        AND (
          "status" IS NULL
          OR UPPER(("status")::text) NOT IN ('COMPLETED', 'NO_REVIEW')
        )
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

  async getReviewerSubmissionPairs(
    challengeId: string,
  ): Promise<Set<string>> {
    if (!challengeId) {
      return new Set<string>();
    }

    const query = Prisma.sql`
      SELECT review."submissionId", review."resourceId"
      FROM ${ReviewService.REVIEW_TABLE} AS review
      INNER JOIN ${ReviewService.SUBMISSION_TABLE} AS submission
        ON submission."id" = review."submissionId"
      WHERE submission."challengeId" = ${challengeId}
    `;

    try {
      const records = await this.prisma.$queryRaw<ReviewRecord[]>(query);
      const result = new Set<string>();

      for (const record of records) {
        if (!record.submissionId || !record.resourceId) {
          continue;
        }

        result.add(this.composeKey(record.resourceId, record.submissionId));
      }

      void this.dbLogger.logAction('review.getReviewerSubmissionPairs', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          pairCount: result.size,
        },
      });

      return result;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getReviewerSubmissionPairs', {
        challengeId,
        status: 'ERROR',
        source: ReviewService.name,
        details: {
          error: err.message,
        },
      });
      throw err;
    }
  }

  async getPendingReviewCount(
    phaseId: string,
    challengeId?: string,
  ): Promise<number> {
    const query = Prisma.sql`
      SELECT COUNT(*)::int AS count
      FROM ${ReviewService.REVIEW_TABLE}
      WHERE "phaseId" = ${phaseId}
        AND (
          "status" IS NULL
          OR UPPER(("status")::text) NOT IN ('COMPLETED', 'NO_REVIEW')
        )
    `;

    try {
      const [record] = await this.prisma.$queryRaw<PendingCountRecord[]>(query);
      const rawCount = Number(record?.count ?? 0);
      const count = Number.isFinite(rawCount) ? rawCount : 0;

      void this.dbLogger.logAction('review.getPendingReviewCount', {
        challengeId: challengeId ?? null,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          phaseId,
          pendingCount: count,
        },
      });

      return count;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getPendingReviewCount', {
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
    submissionId: string | null,
    resourceId: string,
    phaseId: string,
    scorecardId: string,
    challengeId: string,
  ): Promise<boolean> {
    const insert = Prisma.sql`
      INSERT INTO ${ReviewService.REVIEW_TABLE} (
        "resourceId",
        "phaseId",
        "submissionId",
        "scorecardId",
        "status",
        "createdAt",
        "updatedAt"
      )
      SELECT
        ${resourceId},
        ${phaseId},
        ${submissionId},
        ${scorecardId},
        'PENDING',
        NOW(),
        NOW()
      WHERE NOT EXISTS (
        SELECT 1
        FROM ${ReviewService.REVIEW_TABLE} existing
        WHERE existing."resourceId" = ${resourceId}
          AND existing."phaseId" = ${phaseId}
          AND existing."submissionId" IS NOT DISTINCT FROM ${submissionId}
          AND existing."scorecardId" IS NOT DISTINCT FROM ${scorecardId}
          AND (
            existing."status" IS NULL
            OR UPPER((existing."status")::text) NOT IN ('COMPLETED', 'NO_REVIEW')
          )
      )
      RETURNING "id"
    `;

    try {
      const lockId = this.buildPendingReviewLockId(
        phaseId,
        resourceId,
        submissionId,
        scorecardId,
      );

      const { created, reviewId, pendingReviewIds } =
        await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw(Prisma.sql`
            SELECT pg_advisory_xact_lock(${lockId})
          `);

          const insertedReviews = await tx.$queryRaw<
            Array<{ id: string }>
          >(insert);

          if (insertedReviews.length > 0) {
            return {
              created: true,
              reviewId: insertedReviews[0]?.id ?? null,
              pendingReviewIds: insertedReviews.map((row) => row.id),
            };
          }

          const existingPendingReviews = await tx.$queryRaw<
            Array<{ id: string }>
          >(Prisma.sql`
            SELECT existing."id"
            FROM ${ReviewService.REVIEW_TABLE} existing
            WHERE existing."resourceId" = ${resourceId}
              AND existing."phaseId" = ${phaseId}
              AND existing."submissionId" IS NOT DISTINCT FROM ${submissionId}
              AND existing."scorecardId" IS NOT DISTINCT FROM ${scorecardId}
              AND (
                existing."status" IS NULL
                OR UPPER((existing."status")::text) NOT IN ('COMPLETED', 'NO_REVIEW')
              )
            ORDER BY existing."createdAt" DESC, existing."id" DESC
            LIMIT 10
          `);

          return {
            created: false,
            reviewId: existingPendingReviews[0]?.id ?? null,
            pendingReviewIds: existingPendingReviews.map((row) => row.id),
          };
        });

      void this.dbLogger.logAction('review.createPendingReview', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          resourceId,
          submissionId,
          phaseId,
          scorecardId,
          created,
          reviewId,
          pendingReviewIds,
        },
      });

      return created;
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
          scorecardId,
          error: err.message,
          errorStack: err.stack ?? null,
        },
      });
      throw err;
    }
  }

  async deletePendingReviewsForResource(
    phaseId: string,
    resourceId: string,
    challengeId: string,
  ): Promise<number> {
    const query = Prisma.sql`
      DELETE FROM ${ReviewService.REVIEW_TABLE}
      WHERE "phaseId" = ${phaseId}
        AND "resourceId" = ${resourceId}
        AND (
          "status" IS NULL
          OR UPPER(("status")::text) = 'PENDING'
        )
    `;

    try {
      const deleted = await this.prisma.$executeRaw(query);

      void this.dbLogger.logAction('review.deletePendingReviewsForResource', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          phaseId,
          resourceId,
          deletedCount: deleted,
        },
      });

      return deleted;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.deletePendingReviewsForResource', {
        challengeId,
        status: 'ERROR',
        source: ReviewService.name,
        details: {
          phaseId,
          resourceId,
          error: err.message,
        },
      });
      throw err;
    }
  }

  async getActiveSubmissionCount(challengeId: string): Promise<number> {
    const query = Prisma.sql`
      SELECT COUNT(*)::int AS count
      FROM ${ReviewService.SUBMISSION_TABLE}
      WHERE "challengeId" = ${challengeId}
        AND (
          "status" = 'ACTIVE'
          OR "status" IS NULL
        )
    `;

    try {
      const [record] = await this.prisma.$queryRaw<PendingCountRecord[]>(query);
      const rawCount = Number(record?.count ?? 0);
      const count = Number.isFinite(rawCount) ? rawCount : 0;

      void this.dbLogger.logAction('review.getActiveSubmissionCount', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          submissionCount: count,
        },
      });

      return count;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getActiveSubmissionCount', {
        challengeId,
        status: 'ERROR',
        source: ReviewService.name,
        details: {
          error: err.message,
        },
      });
      throw err;
    }
  }

  async getAllSubmissionIdsOrdered(challengeId: string): Promise<string[]> {
    const query = Prisma.sql`
      SELECT "id"
      FROM ${ReviewService.SUBMISSION_TABLE}
      WHERE "challengeId" = ${challengeId}
      ORDER BY "submittedDate" ASC NULLS LAST, "createdAt" ASC, "id" ASC
    `;

    try {
      const submissions =
        await this.prisma.$queryRaw<SubmissionRecord[]>(query);
      const submissionIds = submissions
        .map((record) => record.id)
        .filter(Boolean);

      void this.dbLogger.logAction('review.getAllSubmissionIdsOrdered', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          submissionCount: submissionIds.length,
        },
      });

      return submissionIds;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getAllSubmissionIdsOrdered', {
        challengeId,
        status: 'ERROR',
        source: ReviewService.name,
        details: {
          error: err.message,
        },
      });
      throw err;
    }
  }

  async getCompletedReviewCountForPhase(phaseId: string): Promise<number> {
    const query = Prisma.sql`
      SELECT COUNT(*)::int AS count
      FROM ${ReviewService.REVIEW_TABLE}
      WHERE "phaseId" = ${phaseId}
        AND UPPER(("status")::text) = 'COMPLETED'
    `;

    try {
      const [record] = await this.prisma.$queryRaw<PendingCountRecord[]>(query);
      const rawCount = Number(record?.count ?? 0);
      const count = Number.isFinite(rawCount) ? rawCount : 0;

      void this.dbLogger.logAction('review.getCompletedReviewCountForPhase', {
        challengeId: null,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          phaseId,
          completedCount: count,
        },
      });

      return count;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getCompletedReviewCountForPhase', {
        challengeId: null,
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

  async generateReviewSummaries(
    challengeId: string,
  ): Promise<SubmissionSummary[]> {
    if (!challengeId) {
      return [];
    }

    const aggregationQuery = Prisma.sql`
      SELECT
        s."id" AS "submissionId",
        s."legacySubmissionId" AS "legacySubmissionId",
        s."memberId" AS "memberId",
        s."submittedDate" AS "submittedDate",
        COALESCE(AVG(r."finalScore"), 0) AS "aggregateScore",
        MAX(r."scorecardId") AS "scorecardId",
        MAX(sc."legacyId") AS "scorecardLegacyId",
        MAX(sc."minimumPassingScore") AS "minimumPassingScore"
      FROM ${ReviewService.SUBMISSION_TABLE} s
      LEFT JOIN ${ReviewService.REVIEW_TABLE} r
        ON r."submissionId" = s."id"
        AND (r."status"::text = 'COMPLETED')
      LEFT JOIN ${ReviewService.SCORECARD_TABLE} sc
        ON sc."id" = r."scorecardId"
      WHERE s."challengeId" = ${challengeId}
      GROUP BY s."id", s."legacySubmissionId", s."memberId", s."submittedDate"
    `;

    const aggregationRows =
      await this.prisma.$queryRaw<SubmissionAggregationRecord[]>(
        aggregationQuery,
      );

    const summaries: SubmissionSummary[] = aggregationRows.map((row) => {
      const aggregateScore = Number(row.aggregateScore ?? 0);
      const passingScore = this.resolvePassingScore(row.minimumPassingScore);
      const isPassing = aggregateScore >= passingScore;

      return {
        submissionId: row.submissionId,
        legacySubmissionId: row.legacySubmissionId ?? null,
        memberId: row.memberId ?? null,
        submittedDate: row.submittedDate ? new Date(row.submittedDate) : null,
        aggregateScore,
        scorecardId: row.scorecardId ?? null,
        scorecardLegacyId: row.scorecardLegacyId ?? null,
        passingScore,
        isPassing,
      };
    });

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`
          DELETE FROM ${ReviewService.REVIEW_SUMMATION_TABLE}
          WHERE "submissionId" IN (
            SELECT "id"
            FROM ${ReviewService.SUBMISSION_TABLE}
            WHERE "challengeId" = ${challengeId}
          )
        `,
      );

      for (const summary of summaries) {
        await tx.$executeRaw(
          Prisma.sql`
            INSERT INTO ${ReviewService.REVIEW_SUMMATION_TABLE} (
              "submissionId",
              "legacySubmissionId",
              "aggregateScore",
              "scorecardId",
              "scorecardLegacyId",
              "isPassing",
              "isFinal",
              "reviewedDate",
              "createdAt",
              "createdBy",
              "updatedAt",
              "updatedBy"
            )
            VALUES (
              ${summary.submissionId},
              ${summary.legacySubmissionId},
              ${summary.aggregateScore},
              ${summary.scorecardId},
              ${summary.scorecardLegacyId},
              ${summary.isPassing},
              true,
              ${now},
              ${now},
              'autopilot',
              ${now},
              'autopilot'
            )
          `,
        );
      }
    });

    void this.dbLogger.logAction('review.generateReviewSummaries', {
      challengeId,
      status: 'SUCCESS',
      source: ReviewService.name,
      details: {
        submissionCount: summaries.length,
        passingCount: summaries.filter((summary) => summary.isPassing).length,
      },
    });

    return summaries;
  }

  private composeKey(resourceId: string, submissionId: string): string {
    return `${resourceId}:${submissionId}`;
  }

  async getReviewById(reviewId: string): Promise<ReviewDetailRecord | null> {
    if (!reviewId) {
      return null;
    }

    const query = Prisma.sql`
      SELECT
        "id",
        "phaseId",
        "resourceId",
        "submissionId",
        "scorecardId",
        "finalScore" AS "score",
        "status"
      FROM ${ReviewService.REVIEW_TABLE}
      WHERE "id" = ${reviewId}
      LIMIT 1
    `;

    try {
      const [record] = await this.prisma.$queryRaw<ReviewDetailRecord[]>(query);

      void this.dbLogger.logAction('review.getReviewById', {
        challengeId: null,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          reviewId,
          found: Boolean(record),
          phaseId: record?.phaseId ?? null,
        },
      });

      return record ?? null;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getReviewById', {
        challengeId: null,
        status: 'ERROR',
        source: ReviewService.name,
        details: {
          reviewId,
          error: err.message,
        },
      });
      throw err;
    }
  }

  async getScorecardPassingScore(
    scorecardId: string | null,
  ): Promise<number> {
    if (!scorecardId) {
      return 50;
    }

    const query = Prisma.sql`
      SELECT "minimumPassingScore"
      FROM "scorecard"
      WHERE "id" = ${scorecardId}
      LIMIT 1
    `;

    try {
      const [record] = await this.prisma.$queryRaw<ScorecardRecord[]>(query);
      const passingScore = this.resolvePassingScore(
        record?.minimumPassingScore ?? null,
      );

      void this.dbLogger.logAction('review.getScorecardPassingScore', {
        challengeId: null,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          scorecardId,
          passingScore,
          minimumPassingScore: record?.minimumPassingScore ?? null,
        },
      });

      return passingScore;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getScorecardPassingScore', {
        challengeId: null,
        status: 'ERROR',
        source: ReviewService.name,
        details: {
          scorecardId,
          error: err.message,
        },
      });
      throw err;
    }
  }

  async getScorecardIdByName(name: string): Promise<string | null> {
    if (!name) {
      return null;
    }

    const query = Prisma.sql`
      SELECT "id"
      FROM ${ReviewService.SCORECARD_TABLE}
      WHERE "name" = ${name}
      LIMIT 1
    `;

    try {
      const [record] = await this.prisma.$queryRaw<{ id: string | null }[]>(
        query,
      );

      const id = record?.id ?? null;

      void this.dbLogger.logAction('review.getScorecardIdByName', {
        challengeId: null,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          name,
          scorecardId: id,
        },
      });

      return id;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getScorecardIdByName', {
        challengeId: null,
        status: 'ERROR',
        source: ReviewService.name,
        details: {
          name,
          error: err.message,
        },
      });
      throw err;
    }
  }

  async getPendingAppealCount(challengeId: string): Promise<number> {
    const query = Prisma.sql`
      SELECT COUNT(*)::int AS count
      FROM ${ReviewService.APPEAL_TABLE} a
      INNER JOIN ${ReviewService.REVIEW_ITEM_COMMENT_TABLE} ric
        ON ric."id" = a."reviewItemCommentId"
      INNER JOIN ${ReviewService.REVIEW_ITEM_TABLE} ri
        ON ri."id" = ric."reviewItemId"
      INNER JOIN ${ReviewService.REVIEW_TABLE} r
        ON r."id" = ri."reviewId"
      INNER JOIN ${ReviewService.SUBMISSION_TABLE} s
        ON s."id" = r."submissionId"
      LEFT JOIN ${ReviewService.APPEAL_RESPONSE_TABLE} ar
        ON ar."appealId" = a."id"
      WHERE s."challengeId" = ${challengeId}
        AND ar."id" IS NULL
    `;

    try {
      const [record] = await this.prisma.$queryRaw<AppealCountRecord[]>(query);
      const rawCount = Number(record?.count ?? 0);
      const count = Number.isFinite(rawCount) ? rawCount : 0;

      void this.dbLogger.logAction('review.getPendingAppealCount', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          pendingAppeals: count,
        },
      });

      return count;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getPendingAppealCount', {
        challengeId,
        status: 'ERROR',
        source: ReviewService.name,
        details: {
          error: err.message,
        },
      });
      throw err;
    }
  }
}
