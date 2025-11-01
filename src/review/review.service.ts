import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { ReviewPrismaService } from './review-prisma.service';
import { AutopilotDbLoggerService } from '../autopilot/services/autopilot-db-logger.service';

interface SubmissionRecord {
  id: string;
}

export interface ActiveContestSubmission {
  id: string;
  memberId: string | null;
  isLatest: boolean;
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

interface ReviewAggregationRow {
  submissionId: string;
  legacySubmissionId: string | null;
  memberId: string | null;
  submittedDate: Date | null;
  finalScore: number | string | null;
  scorecardId: string | null;
  scorecardLegacyId: string | null;
  minimumPassingScore: number | string | null;
  reviewTypeName: string | null;
  scorecardType: string | null;
}

interface ReviewSummationSummaryRecord {
  submissionId: string;
  legacySubmissionId: string | null;
  memberId: string | null;
  submittedDate: Date | null;
  aggregateScore: number | string | null;
  scorecardId: string | null;
  scorecardLegacyId: string | null;
  isPassing: boolean | null;
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
  private static readonly REVIEW_TYPE_TABLE = Prisma.sql`"reviewType"`;
  private static readonly APPEAL_TABLE = Prisma.sql`"appeal"`;
  private static readonly APPEAL_RESPONSE_TABLE = Prisma.sql`"appealResponse"`;
  private static readonly REVIEW_ITEM_COMMENT_TABLE = Prisma.sql`"reviewItemComment"`;
  private static readonly REVIEW_ITEM_TABLE = Prisma.sql`"reviewItem"`;
  private static readonly FINAL_REVIEW_TYPE_NAMES = new Set<string>([
    'REVIEW',
    'REGULAR REVIEW',
    'ITERATIVE REVIEW',
    'PEER REVIEW',
    'POST-MORTEM REVIEW',
    'COMMITTEE REVIEW',
    'FINAL REVIEW',
  ]);
  private static readonly EXCLUDED_REVIEW_TYPE_NAMES = new Set<string>([
    'SCREENING',
    'CHECKPOINT SCREENING',
  ]);
  private static readonly REVIEW_SCORECARD_TYPES = new Set<string>([
    'REVIEW',
    'REGULAR_REVIEW',
    'ITERATIVE_REVIEW',
  ]);

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

  private static normalizeTypeName(
    value: string | null | undefined,
  ): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    return trimmed.toUpperCase();
  }

  private static isFinalReviewType(value: string | null | undefined): boolean {
    const normalized = ReviewService.normalizeTypeName(value);
    if (!normalized) {
      return false;
    }

    if (ReviewService.EXCLUDED_REVIEW_TYPE_NAMES.has(normalized)) {
      return false;
    }

    return ReviewService.FINAL_REVIEW_TYPE_NAMES.has(normalized);
  }

  private static isScreeningReviewType(
    value: string | null | undefined,
  ): boolean {
    const normalized = ReviewService.normalizeTypeName(value);
    if (!normalized) {
      return false;
    }

    return ReviewService.EXCLUDED_REVIEW_TYPE_NAMES.has(normalized);
  }

  private static isReviewScorecardType(
    value: string | null | undefined,
  ): boolean {
    const normalized = ReviewService.normalizeTypeName(value);
    if (!normalized) {
      return false;
    }

    return ReviewService.REVIEW_SCORECARD_TYPES.has(normalized);
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

      const winnersFromSummations =
        this.selectUniqueMemberScoresFromSummations(rows, limit);

      let winners = winnersFromSummations;
      let dataSource: 'reviewSummation' | 'reviewSummaries' = 'reviewSummation';

      if (!winners.length) {
        winners = await this.deriveTopScoresFromSummaries(challengeId, limit);
        if (winners.length) {
          dataSource = 'reviewSummaries';
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
          dataSource,
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

  async getTopCheckpointReviewScores(
    challengeId: string,
    phaseId: string,
    limit = 3,
  ): Promise<
    Array<{
      memberId: string;
      submissionId: string;
      score: number;
    }>
  > {
    if (!challengeId || !phaseId) {
      return [];
    }

    const fetchLimit = Math.max(limit, 1) * 5;
    const limitClause = Prisma.sql`LIMIT ${fetchLimit}`;

    try {
      const rows = await this.prisma.$queryRaw<
        Array<{
          memberId: string | null;
          submissionId: string | null;
          score: number | string | null;
        }>
      >(Prisma.sql`
        SELECT
          s."memberId" AS "memberId",
          s."id" AS "submissionId",
          COALESCE(r."finalScore", r."initialScore") AS "score"
        FROM ${ReviewService.REVIEW_TABLE} r
        INNER JOIN ${ReviewService.SUBMISSION_TABLE} s
          ON s."id" = r."submissionId"
        WHERE s."challengeId" = ${challengeId}
          AND r."phaseId" = ${phaseId}
          AND s."memberId" IS NOT NULL
          AND s."id" IS NOT NULL
          AND COALESCE(r."finalScore", r."initialScore") IS NOT NULL
          AND (UPPER((r."status")::text) = 'COMPLETED' OR r."status" IS NULL)
          AND r."committed" = true
          AND UPPER((s."type")::text) = 'CHECKPOINT_SUBMISSION'
        ORDER BY COALESCE(r."finalScore", r."initialScore") DESC,
                 s."submittedDate" ASC NULLS LAST,
                 s."id" ASC
        ${limitClause}
      `);

      const winners = this.selectUniqueCheckpointScores(rows, limit);

      void this.dbLogger.logAction('review.getTopCheckpointReviewScores', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          phaseId,
          limit,
          rowsExamined: rows.length,
          winnersCount: winners.length,
        },
      });

      return winners;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getTopCheckpointReviewScores', {
        challengeId,
        status: 'ERROR',
        source: ReviewService.name,
        details: {
          phaseId,
          limit,
          error: err.message,
        },
      });
      throw err;
    }
  }

  private selectUniqueMemberScoresFromSummations(
    rows: Array<{
      memberId: string | null;
      submissionId: string;
      aggregateScore: number | string | null;
    }>,
    limit: number,
  ): Array<{ memberId: string; submissionId: string; aggregateScore: number }> {
    const winners: Array<{
      memberId: string;
      submissionId: string;
      aggregateScore: number;
    }> = [];
    const seenMembers = new Set<string>();

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

    return winners;
  }

  private selectUniqueCheckpointScores(
    rows: Array<{
      memberId: string | null;
      submissionId: string | null;
      score: number | string | null;
    }>,
    limit: number,
  ): Array<{
    memberId: string;
    submissionId: string;
    score: number;
  }> {
    if (!Array.isArray(rows) || limit <= 0) {
      return [];
    }

    const winners: Array<{
      memberId: string;
      submissionId: string;
      score: number;
    }> = [];

    const seenMembers = new Set<string>();
    const seenSubmissions = new Set<string>();

    for (const row of rows) {
      const memberId = row.memberId?.trim();
      const submissionId = row.submissionId?.trim();
      if (!memberId || !submissionId) {
        continue;
      }

      if (seenMembers.has(memberId) || seenSubmissions.has(submissionId)) {
        continue;
      }

      const scoreValue =
        typeof row.score === 'number' ? row.score : Number(row.score);
      if (!Number.isFinite(scoreValue)) {
        continue;
      }

      winners.push({
        memberId,
        submissionId,
        score: scoreValue,
      });

      seenMembers.add(memberId);
      seenSubmissions.add(submissionId);

      if (winners.length >= limit) {
        break;
      }
    }

    return winners;
  }

  private async deriveTopScoresFromSummaries(
    challengeId: string,
    limit: number,
  ): Promise<
    Array<{ memberId: string; submissionId: string; aggregateScore: number }>
  > {
    const summaries = await this.generateReviewSummaries(challengeId);
    if (!summaries.length) {
      return [];
    }

    const seenMembers = new Set<string>();
    const sortedSummaries = summaries
      .filter((summary) => summary.isPassing)
      .sort((a, b) => {
        if (b.aggregateScore !== a.aggregateScore) {
          return b.aggregateScore - a.aggregateScore;
        }

        const timeA = a.submittedDate?.getTime() ?? Number.POSITIVE_INFINITY;
        const timeB = b.submittedDate?.getTime() ?? Number.POSITIVE_INFINITY;
        if (timeA !== timeB) {
          return timeA - timeB;
        }

        return a.submissionId.localeCompare(b.submissionId);
      });

    const winners: Array<{
      memberId: string;
      submissionId: string;
      aggregateScore: number;
    }> = [];

    for (const summary of sortedSummaries) {
      const memberId = summary.memberId?.trim();
      if (!memberId || seenMembers.has(memberId)) {
        continue;
      }

      winners.push({
        memberId,
        submissionId: summary.submissionId,
        aggregateScore: summary.aggregateScore,
      });
      seenMembers.add(memberId);

      if (winners.length >= limit) {
        break;
      }
    }

    return winners;
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

  async getActiveContestSubmissions(
    challengeId: string,
  ): Promise<ActiveContestSubmission[]> {
    const query = Prisma.sql`
      SELECT
        s."id",
        s."memberId",
        CASE
          WHEN ROW_NUMBER() OVER (
            PARTITION BY COALESCE(s."memberId", s."id")
            ORDER BY
              s."submittedDate" DESC NULLS LAST,
              s."createdAt" DESC NULLS LAST,
              s."updatedAt" DESC NULLS LAST,
              s."id" DESC
          ) = 1 THEN TRUE
          ELSE FALSE
        END AS "isLatest"
      FROM ${ReviewService.SUBMISSION_TABLE} s
      WHERE s."challengeId" = ${challengeId}
        AND (s."status" = 'ACTIVE' OR s."status" IS NULL)
        AND (
          s."type" IS NULL
          OR UPPER((s."type")::text) = 'CONTEST_SUBMISSION'
        )
    `;

    try {
      const submissions =
        await this.prisma.$queryRaw<
          Array<{ id: string; memberId: string | null; isLatest: boolean }>
        >(query);

      const sanitized = submissions
        .filter((record) => Boolean(record?.id))
        .map((record) => ({
          id: record.id,
          memberId: record.memberId ?? null,
          isLatest: Boolean(record.isLatest),
        }));

      void this.dbLogger.logAction('review.getActiveContestSubmissions', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: { submissionCount: sanitized.length },
      });

      return sanitized;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getActiveContestSubmissions', {
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
    try {
      const submissions = await this.getActiveContestSubmissions(challengeId);
      const submissionIds = submissions.map((record) => record.id);

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
   * with a recorded score (final or raw) greater than or equal to the scorecard's minimumPassingScore.
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
        AND GREATEST(
          COALESCE(r."finalScore", 0),
          COALESCE(r."initialScore", 0)
        ) >= COALESCE(sc."minimumPassingScore", sc."minScore", 50)
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

  async getFailedScreeningSubmissionIds(
    challengeId: string,
    screeningScorecardIds: string[],
  ): Promise<Set<string>> {
    const uniqueIds = Array.from(
      new Set(
        screeningScorecardIds
          .map((id) => id?.trim())
          .filter((id): id is string => Boolean(id)),
      ),
    );

    if (!challengeId || !uniqueIds.length) {
      return new Set();
    }

    const scorecardList = Prisma.join(uniqueIds.map((id) => Prisma.sql`${id}`));

    const query = Prisma.sql`
      SELECT DISTINCT s."id"
      FROM ${ReviewService.SUBMISSION_TABLE} s
      INNER JOIN ${ReviewService.REVIEW_TABLE} r
        ON r."submissionId" = s."id"
      INNER JOIN ${ReviewService.SCORECARD_TABLE} sc
        ON sc."id" = r."scorecardId"
      WHERE s."challengeId" = ${challengeId}
        AND (s."status" = 'ACTIVE' OR s."status" IS NULL)
        AND (
          s."type" IS NULL
          OR UPPER((s."type")::text) = 'CONTEST_SUBMISSION'
        )
        AND r."scorecardId" IN (${scorecardList})
        AND (
          (
            UPPER((r."status")::text) = 'COMPLETED'
            AND GREATEST(
              COALESCE(r."finalScore", 0),
              COALESCE(r."initialScore", 0)
            ) < COALESCE(sc."minimumPassingScore", sc."minScore", 50)
          )
          OR UPPER((r."status")::text) = 'FAILED'
        )
    `;

    try {
      const rows = await this.prisma.$queryRaw<SubmissionRecord[]>(query);
      const failedIds = new Set(
        rows.map((record) => record.id).filter(Boolean),
      );

      void this.dbLogger.logAction('review.getFailedScreeningSubmissionIds', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          screeningScorecardCount: uniqueIds.length,
          failedSubmissionCount: failedIds.size,
        },
      });

      return failedIds;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getFailedScreeningSubmissionIds', {
        challengeId,
        status: 'ERROR',
        source: ReviewService.name,
        details: {
          screeningScorecardCount: uniqueIds.length,
          error: err.message,
        },
      });
      throw err;
    }
  }

  async getPassedScreeningSubmissionIds(
    challengeId: string,
    screeningScorecardIds: string[],
  ): Promise<Set<string>> {
    const uniqueIds = Array.from(
      new Set(
        screeningScorecardIds
          .map((id) => id?.trim())
          .filter((id): id is string => Boolean(id)),
      ),
    );

    if (!challengeId || !uniqueIds.length) {
      return new Set();
    }

    const scorecardList = Prisma.join(uniqueIds.map((id) => Prisma.sql`${id}`));

    const query = Prisma.sql`
      SELECT DISTINCT s."id"
      FROM ${ReviewService.SUBMISSION_TABLE} s
      INNER JOIN ${ReviewService.REVIEW_TABLE} r
        ON r."submissionId" = s."id"
      INNER JOIN ${ReviewService.SCORECARD_TABLE} sc
        ON sc."id" = r."scorecardId"
      WHERE s."challengeId" = ${challengeId}
        AND (s."status" = 'ACTIVE' OR s."status" IS NULL)
        AND (
          s."type" IS NULL
          OR UPPER((s."type")::text) = 'CONTEST_SUBMISSION'
        )
        AND r."scorecardId" IN (${scorecardList})
        AND (
          (
            UPPER((r."status")::text) = 'COMPLETED'
            AND GREATEST(
              COALESCE(r."finalScore", 0),
              COALESCE(r."initialScore", 0)
            ) >= COALESCE(sc."minimumPassingScore", sc."minScore", 50)
          )
          OR UPPER((r."status")::text) = 'PASSED'
          OR UPPER((r."status")::text) = 'APPROVED'
        )
    `;

    try {
      const rows = await this.prisma.$queryRaw<SubmissionRecord[]>(query);
      const passedIds = new Set(rows.map((record) => record.id).filter(Boolean));

      void this.dbLogger.logAction('review.getPassedScreeningSubmissionIds', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          screeningScorecardCount: uniqueIds.length,
          passedSubmissionCount: passedIds.size,
        },
      });

      return passedIds;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getPassedScreeningSubmissionIds', {
        challengeId,
        status: 'ERROR',
        source: ReviewService.name,
        details: {
          screeningScorecardCount: uniqueIds.length,
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

  async updatePendingReviewScorecards(
    challengeId: string,
    phaseId: string,
    scorecardId: string | null,
  ): Promise<number> {
    const trimmedPhaseId = phaseId?.trim();
    const trimmedScorecardId = scorecardId?.trim();

    if (!trimmedPhaseId || !trimmedScorecardId) {
      return 0;
    }

    const query = Prisma.sql`
      UPDATE ${ReviewService.REVIEW_TABLE}
      SET
        "scorecardId" = ${trimmedScorecardId},
        "updatedAt" = NOW()
      WHERE "phaseId" = ${trimmedPhaseId}
        AND (
          "status" IS NULL
          OR UPPER(("status")::text) = 'PENDING'
        )
        AND (
          "scorecardId" IS DISTINCT FROM ${trimmedScorecardId}
        )
    `;

    try {
      const updated = await this.prisma.$executeRaw(query);

      void this.dbLogger.logAction('review.updatePendingReviewScorecards', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          phaseId: trimmedPhaseId,
          scorecardId: trimmedScorecardId,
          updatedCount: updated,
        },
      });

      return updated;
    } catch (error) {
      const err = error as Error;

      void this.dbLogger.logAction('review.updatePendingReviewScorecards', {
        challengeId,
        status: 'ERROR',
        source: ReviewService.name,
        details: {
          phaseId: trimmedPhaseId,
          scorecardId: trimmedScorecardId,
          error: err.message,
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

  async reassignPendingReviewsToResource(
    phaseId: string,
    resourceId: string,
    challengeId: string,
  ): Promise<number> {
    const trimmedPhaseId = phaseId?.trim();
    const trimmedResourceId = resourceId?.trim();

    if (!trimmedPhaseId || !trimmedResourceId) {
      return 0;
    }

    const query = Prisma.sql`
      UPDATE ${ReviewService.REVIEW_TABLE}
      SET
        "resourceId" = ${trimmedResourceId},
        "updatedAt" = NOW()
      WHERE "phaseId" = ${trimmedPhaseId}
        AND (
          "status" IS NULL
          OR UPPER(("status")::text) NOT IN ('COMPLETED', 'NO_REVIEW')
        )
        AND (
          "resourceId" IS DISTINCT FROM ${trimmedResourceId}
        )
    `;

    try {
      const reassigned = await this.prisma.$executeRaw(query);

      void this.dbLogger.logAction(
        'review.reassignPendingReviewsToResource',
        {
          challengeId,
          status: 'SUCCESS',
          source: ReviewService.name,
          details: {
            phaseId: trimmedPhaseId,
            resourceId: trimmedResourceId,
            reassignedCount: reassigned,
          },
        },
      );

      return reassigned;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction(
        'review.reassignPendingReviewsToResource',
        {
          challengeId,
          status: 'ERROR',
          source: ReviewService.name,
          details: {
            phaseId: trimmedPhaseId,
            resourceId: trimmedResourceId,
            error: err.message,
          },
        },
      );
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

    let summaries =
      await this.getSummariesFromReviewSummations(challengeId);
    let usedRebuild = false;

    if (!summaries.length) {
      summaries = await this.rebuildSummariesFromReviews(challengeId);
      usedRebuild = summaries.length > 0;
    } else if (summaries.every((summary) => !summary.isPassing)) {
      const recalculatedSummaries =
        await this.fetchSummariesFromReviews(challengeId);
      const hasRecalculatedSummaries = recalculatedSummaries.length > 0;
      const recalculatedHasPassing = recalculatedSummaries.some(
        (summary) => summary.isPassing,
      );

      const summariesDiffer =
        hasRecalculatedSummaries &&
        !this.areSummariesEquivalent(summaries, recalculatedSummaries);

      if (hasRecalculatedSummaries && (recalculatedHasPassing || summariesDiffer)) {
        await this.replaceReviewSummations(
          challengeId,
          recalculatedSummaries,
        );
        summaries = recalculatedSummaries;
        usedRebuild = true;
      }
    }

    void this.dbLogger.logAction('review.generateReviewSummaries', {
      challengeId,
      status: 'SUCCESS',
      source: ReviewService.name,
      details: {
        submissionCount: summaries.length,
        passingCount: summaries.filter((summary) => summary.isPassing).length,
        rebuiltFromReviews: usedRebuild,
      },
    });

    return summaries;
  }

  private async getSummariesFromReviewSummations(
    challengeId: string,
  ): Promise<SubmissionSummary[]> {
    const rows =
      await this.prisma.$queryRaw<ReviewSummationSummaryRecord[]>(Prisma.sql`
        SELECT
          s."id" AS "submissionId",
          s."legacySubmissionId" AS "legacySubmissionId",
          s."memberId" AS "memberId",
          s."submittedDate" AS "submittedDate",
          rs."aggregateScore" AS "aggregateScore",
          rs."scorecardId" AS "scorecardId",
          rs."scorecardLegacyId" AS "scorecardLegacyId",
          rs."isPassing" AS "isPassing",
          sc."minimumPassingScore" AS "minimumPassingScore"
        FROM ${ReviewService.REVIEW_SUMMATION_TABLE} rs
        INNER JOIN ${ReviewService.SUBMISSION_TABLE} s
          ON s."id" = rs."submissionId"
        LEFT JOIN ${ReviewService.SCORECARD_TABLE} sc
          ON sc."id" = rs."scorecardId"
        WHERE s."challengeId" = ${challengeId}
          AND rs."isFinal" = true
          AND (
            s."type" IS NULL
            OR UPPER((s."type")::text) = 'CONTEST_SUBMISSION'
          )
      `);

    if (!rows.length) {
      return [];
    }

    return rows.map((row) => {
      const aggregateScore = Number(row.aggregateScore ?? 0);
      const passingScore = this.resolvePassingScore(row.minimumPassingScore);
      const isPassing =
        typeof row.isPassing === 'boolean'
          ? row.isPassing
          : aggregateScore >= passingScore;

      return {
        submissionId: row.submissionId,
        legacySubmissionId: row.legacySubmissionId ?? null,
        memberId: row.memberId ?? null,
        submittedDate: row.submittedDate
          ? new Date(row.submittedDate)
          : null,
        aggregateScore,
        scorecardId: row.scorecardId ?? null,
        scorecardLegacyId: row.scorecardLegacyId ?? null,
        passingScore,
        isPassing,
      };
    });
  }

  private async fetchSummariesFromReviews(
    challengeId: string,
  ): Promise<SubmissionSummary[]> {
    const baseQuery = Prisma.sql`
      SELECT
        s."id" AS "submissionId",
        s."legacySubmissionId" AS "legacySubmissionId",
        s."memberId" AS "memberId",
        s."submittedDate" AS "submittedDate",
        r."finalScore" AS "finalScore",
        r."scorecardId" AS "scorecardId",
        sc."legacyId" AS "scorecardLegacyId",
        sc."minimumPassingScore" AS "minimumPassingScore",
        sc."type" AS "scorecardType",
        COALESCE(rt."name", r."typeId") AS "reviewTypeName"
      FROM ${ReviewService.SUBMISSION_TABLE} s
      LEFT JOIN ${ReviewService.REVIEW_TABLE} r
        ON r."submissionId" = s."id"
        AND (r."status"::text = 'COMPLETED')
        AND r."committed" = true
      LEFT JOIN ${ReviewService.SCORECARD_TABLE} sc
        ON sc."id" = r."scorecardId"
      LEFT JOIN ${ReviewService.REVIEW_TYPE_TABLE} rt
        ON rt."id" = r."typeId"
      WHERE s."challengeId" = ${challengeId}
        AND (
          s."type" IS NULL
          OR UPPER((s."type")::text) = 'CONTEST_SUBMISSION'
        )
    `;

    const rows = await this.prisma.$queryRaw<ReviewAggregationRow[]>(baseQuery);
    if (!rows.length) {
      return [];
    }

    interface SubmissionAccumulator {
      submissionId: string;
      legacySubmissionId: string | null;
      memberId: string | null;
      submittedDate: Date | null;
      primarySum: number;
      primaryCount: number;
      primaryScorecardId: string | null;
      primaryScorecardLegacyId: string | null;
      primaryPassingScore: number | null;
      fallbackSum: number;
      fallbackCount: number;
      fallbackScorecardId: string | null;
      fallbackScorecardLegacyId: string | null;
      fallbackPassingScore: number | null;
    }

    const summariesBySubmission = new Map<string, SubmissionAccumulator>();

    for (const row of rows) {
      const submissionId = row.submissionId;
      if (!submissionId) {
        continue;
      }

      let accumulator = summariesBySubmission.get(submissionId);
      if (!accumulator) {
        accumulator = {
          submissionId,
          legacySubmissionId: row.legacySubmissionId ?? null,
          memberId: row.memberId ?? null,
          submittedDate: row.submittedDate
            ? new Date(row.submittedDate)
            : null,
          primarySum: 0,
          primaryCount: 0,
          primaryScorecardId: null,
          primaryScorecardLegacyId: null,
          primaryPassingScore: null,
          fallbackSum: 0,
          fallbackCount: 0,
          fallbackScorecardId: null,
          fallbackScorecardLegacyId: null,
          fallbackPassingScore: null,
        };
        summariesBySubmission.set(submissionId, accumulator);
      } else {
        if (!accumulator.legacySubmissionId && row.legacySubmissionId) {
          accumulator.legacySubmissionId = row.legacySubmissionId;
        }
        if (!accumulator.memberId && row.memberId) {
          accumulator.memberId = row.memberId;
        }
        if (!accumulator.submittedDate && row.submittedDate) {
          accumulator.submittedDate = new Date(row.submittedDate);
        }
      }

      const numericScore = Number(row.finalScore ?? Number.NaN);
      const hasScore = Number.isFinite(numericScore);
      const reviewTypeName = row.reviewTypeName ?? null;
      const scorecardType = row.scorecardType ?? null;

      if (
        hasScore &&
        ReviewService.isFinalReviewType(reviewTypeName)
      ) {
        accumulator.primarySum += numericScore;
        accumulator.primaryCount += 1;
        if (!accumulator.primaryScorecardId && row.scorecardId) {
          accumulator.primaryScorecardId = row.scorecardId;
        }
        if (!accumulator.primaryScorecardLegacyId && row.scorecardLegacyId) {
          accumulator.primaryScorecardLegacyId = row.scorecardLegacyId;
        }
        if (accumulator.primaryPassingScore === null) {
          accumulator.primaryPassingScore = this.resolvePassingScore(
            row.minimumPassingScore,
          );
        }
      } else if (
        hasScore &&
        ReviewService.isReviewScorecardType(scorecardType) &&
        !ReviewService.isScreeningReviewType(reviewTypeName)
      ) {
        accumulator.fallbackSum += numericScore;
        accumulator.fallbackCount += 1;
        if (!accumulator.fallbackScorecardId && row.scorecardId) {
          accumulator.fallbackScorecardId = row.scorecardId;
        }
        if (
          !accumulator.fallbackScorecardLegacyId &&
          row.scorecardLegacyId
        ) {
          accumulator.fallbackScorecardLegacyId = row.scorecardLegacyId;
        }
        if (accumulator.fallbackPassingScore === null) {
          accumulator.fallbackPassingScore = this.resolvePassingScore(
            row.minimumPassingScore,
          );
        }
      }
    }

    const summaries: SubmissionSummary[] = [];

    for (const accumulator of summariesBySubmission.values()) {
      let total = accumulator.primarySum;
      let count = accumulator.primaryCount;
      let scorecardId = accumulator.primaryScorecardId;
      let scorecardLegacyId = accumulator.primaryScorecardLegacyId;
      let passingScore = accumulator.primaryPassingScore;

      if (count === 0 && accumulator.fallbackCount > 0) {
        total = accumulator.fallbackSum;
        count = accumulator.fallbackCount;
        scorecardId = scorecardId ?? accumulator.fallbackScorecardId;
        scorecardLegacyId =
          scorecardLegacyId ?? accumulator.fallbackScorecardLegacyId;
        passingScore = passingScore ?? accumulator.fallbackPassingScore;
      }

      const resolvedPassingScore =
        passingScore ?? this.resolvePassingScore(null);
      const aggregateScore = count > 0 ? total / count : 0;

      summaries.push({
        submissionId: accumulator.submissionId,
        legacySubmissionId: accumulator.legacySubmissionId ?? null,
        memberId: accumulator.memberId ?? null,
        submittedDate: accumulator.submittedDate ?? null,
        aggregateScore,
        scorecardId: scorecardId ?? null,
        scorecardLegacyId: scorecardLegacyId ?? null,
        passingScore: resolvedPassingScore,
        isPassing: aggregateScore >= resolvedPassingScore,
      });
    }

    return summaries;
  }

  private async replaceReviewSummations(
    challengeId: string,
    summaries: SubmissionSummary[],
  ): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`
          DELETE FROM ${ReviewService.REVIEW_SUMMATION_TABLE}
          WHERE "submissionId" IN (
            SELECT "id"
            FROM ${ReviewService.SUBMISSION_TABLE}
            WHERE "challengeId" = ${challengeId}
              AND (
                "type" IS NULL
                OR UPPER(("type")::text) = 'CONTEST_SUBMISSION'
              )
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
  }

  private async rebuildSummariesFromReviews(
    challengeId: string,
  ): Promise<SubmissionSummary[]> {
    const summaries = await this.fetchSummariesFromReviews(challengeId);
    if (!summaries.length) {
      return summaries;
    }

    await this.replaceReviewSummations(challengeId, summaries);

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

  async getTotalAppealCount(challengeId: string): Promise<number> {
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
      WHERE s."challengeId" = ${challengeId}
    `;

    try {
      const [record] = await this.prisma.$queryRaw<AppealCountRecord[]>(query);
      const rawCount = Number(record?.count ?? 0);
      const count = Number.isFinite(rawCount) ? rawCount : 0;

      void this.dbLogger.logAction('review.getTotalAppealCount', {
        challengeId,
        status: 'SUCCESS',
        source: ReviewService.name,
        details: {
          totalAppeals: count,
        },
      });

      return count;
    } catch (error) {
      const err = error as Error;
      void this.dbLogger.logAction('review.getTotalAppealCount', {
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

  private areSummariesEquivalent(
    current: SubmissionSummary[],
    next: SubmissionSummary[],
  ): boolean {
    if (current.length !== next.length) {
      return false;
    }

    const normalize = (summary: SubmissionSummary) => ({
      submissionId: summary.submissionId,
      legacySubmissionId: summary.legacySubmissionId ?? null,
      memberId: summary.memberId ?? null,
      submittedDate: summary.submittedDate
        ? summary.submittedDate.getTime()
        : null,
      aggregateScore: summary.aggregateScore,
      scorecardId: summary.scorecardId ?? null,
      scorecardLegacyId: summary.scorecardLegacyId ?? null,
      passingScore: summary.passingScore,
      isPassing: summary.isPassing,
    });

    const sortBySubmissionId = (
      a: ReturnType<typeof normalize>,
      b: ReturnType<typeof normalize>,
    ) => {
      if (a.submissionId === b.submissionId) {
        return 0;
      }
      return a.submissionId > b.submissionId ? 1 : -1;
    };

    const normalizedCurrent = current.map(normalize).sort(sortBySubmissionId);
    const normalizedNext = next.map(normalize).sort(sortBySubmissionId);

    return normalizedCurrent.every((entry, index) => {
      const other = normalizedNext[index];
      return (
        entry.submissionId === other.submissionId &&
        entry.legacySubmissionId === other.legacySubmissionId &&
        entry.memberId === other.memberId &&
        entry.submittedDate === other.submittedDate &&
        entry.aggregateScore === other.aggregateScore &&
        entry.scorecardId === other.scorecardId &&
        entry.scorecardLegacyId === other.scorecardLegacyId &&
        entry.passingScore === other.passingScore &&
        entry.isPassing === other.isPassing
      );
    });
  }
}
