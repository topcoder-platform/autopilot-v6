import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import type { IChallenge } from '../../challenge/interfaces/challenge.interface';
import { ReviewService } from '../../review/review.service';
import type { ActiveContestSubmission } from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';
import {
  getRoleNamesForPhase,
  REVIEW_PHASE_NAMES,
  SCREENING_PHASE_NAMES,
  APPROVAL_PHASE_NAMES,
  POST_MORTEM_PHASE_NAME,
} from '../constants/review.constants';
import {
  getMemberReviewerConfigs,
  getReviewerConfigsForPhase,
  selectScorecardId,
} from '../utils/reviewer.utils';
import { isTopgearTaskChallenge } from '../constants/challenge.constants';

@Injectable()
export class PhaseReviewService {
  private readonly logger = new Logger(PhaseReviewService.name);

  constructor(
    private readonly challengeApiService: ChallengeApiService,
    private readonly reviewService: ReviewService,
    private readonly resourcesService: ResourcesService,
    private readonly configService: ConfigService,
  ) {}

  async handlePhaseOpened(challengeId: string, phaseId: string): Promise<void> {
    const challenge =
      await this.challengeApiService.getChallengeById(challengeId);
    const phase = challenge.phases.find((p) => p.id === phaseId);

    if (!phase) {
      this.logger.warn(
        `Unable to locate phase ${phaseId} for challenge ${challengeId} when creating pending reviews`,
      );
      return;
    }

    const allowUnlimitedSubmissions =
      this.challengeAllowsUnlimitedSubmissions(challenge);

    const isReviewPhase = REVIEW_PHASE_NAMES.has(phase.name);
    const isScreeningPhase = SCREENING_PHASE_NAMES.has(phase.name);
    const isApprovalPhase = APPROVAL_PHASE_NAMES.has(phase.name);

    if (!isReviewPhase && !isScreeningPhase && !isApprovalPhase) {
      return;
    }

    // Special handling for Post-Mortem: create challenge-level pending reviews (no submissions)
    if (phase.name === POST_MORTEM_PHASE_NAME) {
      // Determine scorecard
      let scorecardId: string | null = null;
      if (isTopgearTaskChallenge(challenge.type)) {
        scorecardId =
          this.configService.get<string | null>(
            'autopilot.topgearPostMortemScorecardId',
          ) ?? null;
        if (!scorecardId) {
          try {
            scorecardId = await this.reviewService.getScorecardIdByName(
              'Topgear Task Post Mortem',
            );
          } catch (_) {
            // Logged inside review service; continue with null
          }
        }
      } else {
        scorecardId =
          this.configService.get<string | null>(
            'autopilot.postMortemScorecardId',
          ) ?? null;

        // Fallback to the standard Topcoder Post Mortem scorecard by name
        if (!scorecardId) {
          try {
            scorecardId = await this.reviewService.getScorecardIdByName(
              'Topcoder Post Mortem',
            );
          } catch (_) {
            // Logged inside review service; continue with null
          }
        }
      }

      if (!scorecardId) {
        this.logger.warn(
          `Post-mortem scorecard is not configured; skipping review creation for challenge ${challengeId}, phase ${phase.id}.`,
        );
        return;
      }

      const roleNames = getRoleNamesForPhase(phase.name);
      const reviewerResources = await this.resourcesService.getReviewerResources(
        challengeId,
        roleNames,
      );

      if (!reviewerResources.length) {
        this.logger.log(
          `No resources found for post-mortem roles on challenge ${challengeId}; skipping review creation for phase ${phase.id}.`,
        );
        return;
      }

      let createdCount = 0;
      for (const resource of reviewerResources) {
        try {
          const created = await this.reviewService.createPendingReview(
            null,
            resource.id,
            phase.id,
            scorecardId,
            challengeId,
          );
          if (created) {
            createdCount++;
          }
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Failed to create post-mortem review for challenge ${challengeId}, phase ${phase.id}, resource ${resource.id}: ${err.message}`,
            err.stack,
          );
        }
      }

      if (createdCount > 0) {
        this.logger.log(
          `Created ${createdCount} post-mortem pending review(s) for challenge ${challengeId}, phase ${phase.id}.`,
        );
      }
      return;
    }

    // Determine reviewer configs for scorecard selection.
    // For screening phases, configs may not be marked isMemberReview, so include all for the phase.
    const reviewerConfigs = (
      isScreeningPhase
        ? getReviewerConfigsForPhase(challenge.reviewers, phase.phaseId)
        : getMemberReviewerConfigs(challenge.reviewers, phase.phaseId)
    ).filter((config) => Boolean(config.scorecardId));

    if (!reviewerConfigs.length) {
      this.logger.log(
        `No member review configurations found for phase ${phase.name} (${phase.id}) on challenge ${challengeId}; skipping review creation`,
      );
      return;
    }

    // Select scorecard
    // For screening phases, reviewer configs may not be flagged as member reviews.
    // Use any configured scorecard IDs for the phase as-is (without re-filtering by isMemberReview).
    let scorecardId: string | null;
    if (isScreeningPhase) {
      const uniqueScorecards = Array.from(
        new Set(
          reviewerConfigs
            .map((config) => config.scorecardId)
            .filter((id): id is string => Boolean(id)),
        ),
      );

      if (uniqueScorecards.length === 0) {
        this.logger.warn(
          `Reviewer configs missing scorecard IDs for challenge ${challengeId}, phase ${phase.id}`,
        );
        return;
      }

      if (uniqueScorecards.length > 1) {
        this.logger.warn(
          `Multiple scorecard IDs detected for challenge ${challengeId}, phase ${phase.id}. Using ${uniqueScorecards[0]} for pending reviews`,
        );
      }

      scorecardId = uniqueScorecards[0] ?? null;
    } else {
      scorecardId = selectScorecardId(
        reviewerConfigs,
        () =>
          this.logger.warn(
            `Member reviewer configs missing scorecard IDs for challenge ${challengeId}, phase ${phase.id}`,
          ),
        (choices) =>
          this.logger.warn(
            `Multiple scorecard IDs detected for challenge ${challengeId}, phase ${phase.id}. Using ${choices[0]} for pending reviews`,
          ),
      );
    }
    if (!scorecardId) {
      return;
    }

    const roleNames = getRoleNamesForPhase(phase.name);
    const reviewerResources = await this.resourcesService.getReviewerResources(
      challengeId,
      roleNames,
    );

    if (!reviewerResources.length) {
      this.logger.log(
        `No reviewer resources found for challenge ${challengeId} and phase ${phase.name}`,
      );
      return;
    }

    let submissionIds: string[] = [];
    if (isApprovalPhase) {
      // Only the top final-scoring submission (winner) should be reviewed
      const winners = await this.reviewService.getTopFinalReviewScores(
        challengeId,
        1,
      );
      submissionIds = winners.map((w) => w.submissionId);
    } else if (phase.name === 'Checkpoint Screening') {
      // For checkpoint screening, review all active checkpoint submissions
      submissionIds = await this.reviewService.getActiveCheckpointSubmissionIds(
        challengeId,
      );
    } else if (phase.name === 'Checkpoint Review') {
      // For checkpoint review, only review submissions that PASSED checkpoint screening
      // Find the screening phase template and its configured scorecard
      const screeningPhase = (challenge.phases ?? []).find(
        (p) => p.name === 'Checkpoint Screening',
      );

      if (!screeningPhase?.phaseId) {
        this.logger.warn(
          `Checkpoint Review opened, but no Checkpoint Screening phase found for challenge ${challengeId}; skipping review creation for phase ${phase.id}`,
        );
        return;
      }

      const screeningConfigs = getReviewerConfigsForPhase(
        challenge.reviewers,
        screeningPhase.phaseId,
      ).filter((c) => Boolean(c.scorecardId));

      // Unique screening scorecard(s) configured
      const screeningScorecardId = Array.from(
        new Set(
          screeningConfigs
            .map((c) => c.scorecardId)
            .filter((id): id is string => Boolean(id)),
        ),
      )[0];

      if (!screeningScorecardId) {
        this.logger.warn(
          `Checkpoint Review opened, but no screening scorecard configured for challenge ${challengeId}; skipping review creation for phase ${phase.id}`,
        );
        return;
      }

      try {
        submissionIds =
          await this.reviewService.getCheckpointPassedSubmissionIds(
            challengeId,
            screeningScorecardId,
          );
      } catch (error) {
        const err = error as Error;
        this.logger.error(
          `Failed to resolve checkpoint-passing submissions for challenge ${challengeId}, phase ${phase.id}: ${err.message}`,
          err.stack,
        );
        throw err;
      }
    } else {
      const activeSubmissions =
        await this.reviewService.getActiveContestSubmissions(challengeId);

      let filteredSubmissions: ActiveContestSubmission[];

      if (allowUnlimitedSubmissions) {
        filteredSubmissions = activeSubmissions;
      } else {
        filteredSubmissions = this.selectLatestSubmissions(activeSubmissions);

        if (!filteredSubmissions.length && activeSubmissions.length) {
          this.logger.warn(
            `No latest submissions found for challenge ${challengeId} in phase ${phase.id}; skipping review creation because only the latest submission per member is reviewed when a submission limit is enforced.`,
          );
        }
      }

      if (!allowUnlimitedSubmissions) {
        const skipped =
          activeSubmissions.length - filteredSubmissions.length;
        if (skipped > 0 && filteredSubmissions.length > 0) {
          this.logger.log(
            `Skipping ${skipped} older submission(s) for challenge ${challengeId} in phase ${phase.id} because only the latest submissions are reviewed when the submission limit is enforced.`,
          );
        }
      }

      submissionIds = Array.from(
        new Set(filteredSubmissions.map((submission) => submission.id)),
      );
    }
    if (
      submissionIds.length &&
      (isApprovalPhase ||
        (isReviewPhase && phase.name !== 'Checkpoint Review'))
    ) {
      submissionIds = await this.excludeFailedScreeningSubmissions(
        challenge,
        submissionIds,
      );
    }

    if (!submissionIds.length) {
      this.logger.log(
        `No submissions found for challenge ${challengeId}; skipping review creation for phase ${phase.name}`,
      );
      return;
    }

    const existingPairs = await this.reviewService.getExistingReviewPairs(
      phase.id,
      challengeId,
    );

    let createdCount = 0;
    for (const resource of reviewerResources) {
      for (const submissionId of submissionIds) {
        const key = `${resource.id}:${submissionId}`;
        if (existingPairs.has(key)) {
          continue;
        }

        try {
          const created = await this.reviewService.createPendingReview(
            submissionId,
            resource.id,
            phase.id,
            scorecardId,
            challengeId,
          );
          existingPairs.add(key);
          if (created) {
            createdCount++;
          }
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Failed to create pending review for challenge ${challengeId}, phase ${phase.id}, submission ${submissionId}, resource ${resource.id}: ${err.message}`,
            err.stack,
          );
        }
      }
    }

    if (createdCount > 0) {
      this.logger.log(
        `Created ${createdCount} pending review(s) for challenge ${challengeId}, phase ${phase.id}`,
      );
    }
  }

  private async excludeFailedScreeningSubmissions(
    challenge: IChallenge,
    submissionIds: string[],
  ): Promise<string[]> {
    if (!submissionIds.length) {
      return submissionIds;
    }

    const screeningScorecardIds = this.getScreeningScorecardIds(challenge);
    if (!screeningScorecardIds.length) {
      return submissionIds;
    }

    try {
      const failedIds =
        await this.reviewService.getFailedScreeningSubmissionIds(
          challenge.id,
          screeningScorecardIds,
        );

      if (!failedIds.size) {
        return submissionIds;
      }

      const filtered = submissionIds.filter((id) => !failedIds.has(id));
      const removedCount = submissionIds.length - filtered.length;

      if (removedCount > 0) {
        this.logger.log(
          `Excluded ${removedCount} submission(s) for challenge ${challenge.id} due to failed screening.`,
        );
      }

      return filtered;
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to filter screened submissions for challenge ${challenge.id}: ${err.message}`,
        err.stack,
      );
      return submissionIds;
    }
  }

  private getScreeningScorecardIds(challenge: IChallenge): string[] {
    const screeningTemplateIds = (challenge.phases ?? [])
      .filter((phase) => phase?.phaseId && phase.name === 'Screening')
      .map((phase) => phase.phaseId);

    const scorecardIds = new Set<string>();

    for (const templateId of screeningTemplateIds) {
      const configs = getReviewerConfigsForPhase(
        challenge.reviewers,
        templateId,
      );

      for (const config of configs) {
        if (config.scorecardId) {
          scorecardIds.add(config.scorecardId);
        }
      }
    }

    if (!scorecardIds.size) {
      const legacy = challenge.legacy as
        | { screeningScorecardId?: unknown }
        | undefined;
      const legacyScorecardId =
        legacy && typeof legacy === 'object'
          ? (legacy as Record<string, unknown>).screeningScorecardId
          : undefined;

      if (
        typeof legacyScorecardId === 'string' &&
        legacyScorecardId.trim()
      ) {
        scorecardIds.add(legacyScorecardId.trim());
      }
    }

    return Array.from(scorecardIds);
  }

  private selectLatestSubmissions(
    submissions: ActiveContestSubmission[],
  ): ActiveContestSubmission[] {
    if (!submissions.length) {
      return [];
    }

    const selected: ActiveContestSubmission[] = [];
    const addedKeys = new Set<string>();

    for (const submission of submissions) {
      if (!submission.isLatest) {
        continue;
      }

      const key = submission.memberId ?? submission.id;
      if (addedKeys.has(key)) {
        continue;
      }

      selected.push(submission);
      addedKeys.add(key);
    }

    return selected;
  }

  private challengeAllowsUnlimitedSubmissions(
    challenge: IChallenge,
  ): boolean {
    const metadata = challenge.metadata ?? {};
    const rawValue = metadata['submissionLimit'];

    if (rawValue == null) {
      return false;
    }

    const warnUnrecognized = (value: unknown) =>
      this.warnUnrecognizedSubmissionLimit(challenge, value);

    let parsed: unknown = rawValue;

    if (typeof rawValue === 'string') {
      const trimmed = rawValue.trim();
      if (!trimmed) {
        warnUnrecognized(rawValue);
        return false;
      }

      try {
        parsed = JSON.parse(trimmed);
      } catch {
        const numericValue = Number(trimmed);
        if (Number.isFinite(numericValue) && numericValue > 0) {
          return false;
        }
        const normalized = trimmed.toLowerCase();
        if (['unlimited', 'false', '0', 'no', 'none'].includes(normalized)) {
          return true;
        }
        warnUnrecognized(trimmed);
        return false;
      }
    }

    if (typeof parsed === 'number') {
      return !(Number.isFinite(parsed) && parsed > 0);
    }

    if (typeof parsed === 'string') {
      const numericValue = Number(parsed);
      if (Number.isFinite(numericValue) && numericValue > 0) {
        return false;
      }
      const normalized = parsed.trim().toLowerCase();
      if (['unlimited', 'false', '0', 'no', 'none'].includes(normalized)) {
        return true;
      }
      warnUnrecognized(parsed);
      return false;
    }

    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;

      const unlimited = this.parseBooleanFlag(record.unlimited);
      if (unlimited === true) {
        return true;
      }

      const candidates = [
        record.count,
        record.max,
        record.maximum,
        record.limitCount,
        record.value,
      ];

      for (const candidate of candidates) {
        if (candidate === undefined || candidate === null) {
          continue;
        }
        const numericValue = Number(candidate);
        if (Number.isFinite(numericValue) && numericValue > 0) {
          return false;
        }
      }

      const limitFlag = this.parseBooleanFlag(record.limit);
      if (limitFlag === true) {
        return false;
      }
      if (limitFlag === false) {
        return true;
      }

      warnUnrecognized(record);
      return false;
    }

    warnUnrecognized(parsed);
    return false;
  }

  private warnUnrecognizedSubmissionLimit(
    challenge: IChallenge,
    value: unknown,
  ): void {
    const valueDescription = this.describeSubmissionLimitValue(value);
    this.logger.warn(
      `Unrecognized submissionLimit metadata value ${valueDescription} for challenge ${challenge.id}; defaulting to limited submissions.`,
    );
  }

  private describeSubmissionLimitValue(value: unknown): string {
    if (value === undefined) {
      return 'undefined';
    }
    if (value === null) {
      return 'null';
    }
    if (typeof value === 'string') {
      return value.trim().length ? `"${value}"` : '(empty string)';
    }
    if (typeof value === 'number') {
      if (Number.isNaN(value)) {
        return 'NaN';
      }
      return value.toString();
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return Object.prototype.toString.call(value);
      }
    }
    return String(value);
  }

  private parseBooleanFlag(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', 'yes', '1'].includes(normalized)) {
        return true;
      }
      if (['false', 'no', '0'].includes(normalized)) {
        return false;
      }
      return null;
    }

    if (typeof value === 'number') {
      if (value === 1) {
        return true;
      }
      if (value === 0) {
        return false;
      }
      return null;
    }

    return null;
  }
}
