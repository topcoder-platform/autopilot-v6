import { Injectable, Logger } from '@nestjs/common';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import {
  IChallenge,
  IPhase,
} from '../../challenge/interfaces/challenge.interface';
import { SchedulerService } from './scheduler.service';
import { PhaseReviewService } from './phase-review.service';
import { ReviewAssignmentService } from './review-assignment.service';
import { ReviewService } from '../../review/review.service';
import {
  AutopilotOperator,
  ChallengeUpdatePayload,
  PhaseTransitionPayload,
} from '../interfaces/autopilot.interface';
import {
  APPROVAL_PHASE_NAMES,
  DEFAULT_APPEALS_RESPONSE_PHASE_NAMES,
  REVIEW_PHASE_NAMES,
  SCREENING_PHASE_NAMES,
} from '../constants/review.constants';
import { getNormalizedStringArray, isActiveStatus } from '../utils/config.utils';
import { ConfigService } from '@nestjs/config';
import {
  getMemberReviewerConfigs,
  getReviewerConfigsForPhase,
  selectScorecardId,
} from '../utils/reviewer.utils';

@Injectable()
export class PhaseScheduleManager {
  private readonly logger = new Logger(PhaseScheduleManager.name);
  private readonly appealsResponsePhaseNames: Set<string>;
  private static readonly OVERDUE_PHASE_GRACE_PERIOD_MS = 60_000;

  constructor(
    private readonly schedulerService: SchedulerService,
    private readonly challengeApiService: ChallengeApiService,
    private readonly phaseReviewService: PhaseReviewService,
    private readonly reviewAssignmentService: ReviewAssignmentService,
    private readonly reviewService: ReviewService,
    private readonly configService: ConfigService,
  ) {
    this.schedulerService.setPhaseChainCallback(
      (
        challengeId: string,
        projectId: number,
        projectStatus: string,
        nextPhases: IPhase[],
      ) => {
        void this.openAndScheduleNextPhases(
          challengeId,
          projectId,
          projectStatus,
          nextPhases,
        );
      },
    );

    this.appealsResponsePhaseNames = new Set(
      getNormalizedStringArray(
        this.configService.get('autopilot.appealsResponsePhaseNames'),
        Array.from(DEFAULT_APPEALS_RESPONSE_PHASE_NAMES),
      ),
    );
  }

  async schedulePhaseTransition(
    phaseData: PhaseTransitionPayload,
  ): Promise<string> {
    const jobId = this.schedulerService.buildJobId(
      phaseData.challengeId,
      phaseData.phaseId,
    );

    const existingJob = this.schedulerService.getScheduledTransition(jobId);
    if (existingJob) {
      this.logger.log(
        `Canceling existing schedule ${jobId} before scheduling new transition.`,
      );
      const canceled =
        await this.schedulerService.cancelScheduledTransition(jobId);
      if (!canceled) {
        this.logger.warn(
          `Failed to cancel existing schedule ${jobId} for challenge ${phaseData.challengeId}.`,
        );
      }
    }

    const newJobId =
      await this.schedulerService.schedulePhaseTransition(phaseData);

    this.logger.log(
      `Scheduled phase transition for challenge ${phaseData.challengeId}, phase ${phaseData.phaseId} at ${phaseData.date}`,
    );
    return newJobId;
  }

  async cancelPhaseTransition(
    challengeId: string,
    phaseId: string,
  ): Promise<boolean> {
    const jobId = this.schedulerService.buildJobId(challengeId, phaseId);
    const scheduledJob = this.schedulerService.getScheduledTransition(jobId);

    if (!scheduledJob) {
      this.logger.warn(
        `No active schedule found for challenge ${challengeId}, phase ${phaseId}`,
      );
      return false;
    }

    const canceled =
      await this.schedulerService.cancelScheduledTransition(jobId);
    if (canceled) {
      this.logger.log(
        `Canceled scheduled transition for phase ${phaseId} on challenge ${challengeId}`,
      );
      return true;
    }

    this.logger.warn(
      `Unable to cancel scheduled transition ${jobId}; job may have already executed.`,
    );
    return false;
  }

  async reschedulePhaseTransition(
    challengeId: string,
    newPhaseData: PhaseTransitionPayload,
  ): Promise<string> {
    const jobId = this.schedulerService.buildJobId(
      challengeId,
      newPhaseData.phaseId,
    );
    const existingJob = this.schedulerService.getScheduledTransition(jobId);
    let wasRescheduled = false;

    if (existingJob && existingJob.date && newPhaseData.date) {
      const existingTime = new Date(existingJob.date).getTime();
      const newTime = new Date(newPhaseData.date).getTime();

      if (existingTime === newTime) {
        this.logger.log(
          `No change detected for challenge ${challengeId}, phase ${newPhaseData.phaseId}; skipping reschedule.`,
        );
        return jobId;
      }

      this.logger.log(
        `Detected change in end time for challenge ${challengeId}, phase ${newPhaseData.phaseId}; rescheduling.`,
      );
      wasRescheduled = true;
    }

    const newJobId = await this.schedulePhaseTransition(newPhaseData);

    if (wasRescheduled) {
      this.logger.log(
        `Successfully rescheduled phase ${newPhaseData.phaseId} with new end time: ${newPhaseData.date}`,
      );
    }

    return newJobId;
  }

  async handlePhaseTransition(message: PhaseTransitionPayload): Promise<void> {
    this.logger.log(
      `Consumed phase transition event: ${JSON.stringify(message)}`,
    );

    if (!isActiveStatus(message.projectStatus)) {
      this.logger.log(
        `Ignoring phase transition for challenge ${message.challengeId} with status ${message.projectStatus}; only ACTIVE challenges are processed.`,
      );
      return;
    }

    try {
      await this.schedulerService.advancePhase(message);
      this.logger.log(
        `Successfully processed ${message.state} event for phase ${message.phaseId} (challenge ${message.challengeId})`,
      );

      if (message.state === 'END') {
        const canceled = await this.cancelPhaseTransition(
          message.challengeId,
          message.phaseId,
        );
        if (canceled) {
          this.logger.log(
            `Cleaned up job for phase ${message.phaseId} (challenge ${message.challengeId}) from registry after consuming event.`,
          );
        }
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to advance phase ${message.phaseId} for challenge ${message.challengeId}: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  async handleNewChallenge(challenge: ChallengeUpdatePayload): Promise<void> {
    this.logger.log(
      `Handling new challenge creation: ${JSON.stringify(challenge)}`,
    );
    try {
      const challengeDetails = await this.challengeApiService.getChallengeById(
        challenge.id,
      );

      if (!isActiveStatus(challengeDetails.status)) {
        this.logger.log(
          `Skipping challenge ${challenge.id} with status ${challengeDetails.status}; only ACTIVE challenges are processed.`,
        );
        return;
      }

      if (!challengeDetails.phases) {
        this.logger.warn(
          `Challenge ${challenge.id} has no phases to schedule.`,
        );
        return;
      }

      await this.scheduleRelevantPhases(challengeDetails, {
        operator: AutopilotOperator.SYSTEM_NEW_CHALLENGE,
        schedulePhase: (payload) => this.schedulePhaseTransition(payload),
        onNoPhases: () =>
          this.logger.log(
            `No phase needs to be scheduled for new challenge ${challenge.id}`,
          ),
        onMissingScheduleData: () =>
          this.logger.warn(
            `Unable to schedule any phases for new challenge ${challenge.id} due to missing schedule data.`,
          ),
        onSuccess: (summaries) =>
          this.logger.log(
            `Scheduled ${summaries.length} phase(s) for new challenge ${challenge.id}: ${summaries.join('; ')}`,
          ),
        onMissingDates: (phase, stateLabel) =>
          this.logger.warn(
            `Next phase ${phase.id} for new challenge ${challenge.id} has no scheduled ${stateLabel} date. Skipping.`,
          ),
      });
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Error handling new challenge creation for id ${challenge.id}: ${err.message}`,
        err.stack,
      );
    }
  }

  async handleChallengeUpdate(message: ChallengeUpdatePayload): Promise<void> {
    this.logger.log(`Handling challenge update: ${JSON.stringify(message)}`);

    try {
      let challengeDetails = await this.challengeApiService.getChallengeById(
        message.id,
      );

      if (!isActiveStatus(challengeDetails.status)) {
        this.logger.log(
          `Skipping challenge ${message.id} update with status ${challengeDetails.status}; only ACTIVE challenges are processed.`,
        );
        return;
      }

      const immediateClosures =
        await this.processPastDueOpenPhases(challengeDetails);

      if (immediateClosures > 0) {
        this.logger.log(
          `Processed ${immediateClosures} overdue phase(s) immediately for challenge ${message.id}; refreshing challenge snapshot before rescheduling.`,
        );

        challengeDetails = await this.challengeApiService.getChallengeById(
          message.id,
        );

        if (!isActiveStatus(challengeDetails.status)) {
          this.logger.log(
            `Skipping challenge ${message.id} update after immediate processing; status is now ${challengeDetails.status}.`,
          );
          return;
        }
      }

      if (!challengeDetails.phases) {
        this.logger.warn(
          `Updated challenge ${message.id} has no phases to process.`,
        );
        return;
      }

      await this.scheduleRelevantPhases(challengeDetails, {
        operator: message.operator,
        schedulePhase: (payload) =>
          this.reschedulePhaseTransition(challengeDetails.id, payload),
        onNoPhases: () =>
          this.logger.log(
            `No phase needs to be rescheduled for updated challenge ${message.id}`,
          ),
        onMissingScheduleData: () =>
          this.logger.warn(
            `Unable to reschedule any phases for updated challenge ${message.id} due to missing schedule data.`,
          ),
        onSuccess: (summaries) =>
          this.logger.log(
            `Rescheduled ${summaries.length} phase(s) for updated challenge ${message.id}: ${summaries.join('; ')}`,
          ),
        onMissingDates: (phase, stateLabel) =>
          this.logger.warn(
            `Next phase ${phase.id} for updated challenge ${message.id} has no scheduled ${stateLabel} date. Skipping.`,
          ),
      });

      const openPhasesRequiringScorecards = (challengeDetails.phases ?? []).filter(
        (phase) =>
          phase.isOpen === true &&
          (SCREENING_PHASE_NAMES.has(phase.name) ||
            REVIEW_PHASE_NAMES.has(phase.name) ||
            APPROVAL_PHASE_NAMES.has(phase.name)),
      );

      if (openPhasesRequiringScorecards.length > 0) {
        const phaseNames = openPhasesRequiringScorecards
          .map((phase) => phase.name)
          .join(', ');
        this.logger.log(
          `[MANUAL PHASE DETECTION] Detected ${openPhasesRequiringScorecards.length} open phase(s) requiring scorecards for challenge ${challengeDetails.id}: ${phaseNames}`,
        );

        let processedCount = 0;
        for (const phase of openPhasesRequiringScorecards) {
          try {
            this.logger.log(
              `[MANUAL PHASE DETECTION] Processing open phase ${phase.id} (${phase.name}) for challenge ${challengeDetails.id}`,
            );

            const targetScorecardId =
              this.resolveScorecardIdForOpenPhase(challengeDetails, phase);

            if (targetScorecardId) {
              await this.updatePendingReviewScorecards(
                challengeDetails.id,
                phase,
                targetScorecardId,
              );
            } else {
              this.logger.debug(
                `[MANUAL PHASE DETECTION] No scorecard detected for open phase ${phase.id} (${phase.name}) on challenge ${challengeDetails.id}; skipping pending review updates.`,
              );
            }

            await this.phaseReviewService.handlePhaseOpenedForChallenge(
              challengeDetails,
              phase.id,
            );
            processedCount += 1;
            this.logger.log(
              `[MANUAL PHASE DETECTION] Successfully processed open phase ${phase.id} (${phase.name}) for challenge ${challengeDetails.id}`,
            );
          } catch (error) {
            const err = error as Error;
            this.logger.error(
              `[MANUAL PHASE DETECTION] Failed to process open phase ${phase.id} (${phase.name}) for challenge ${challengeDetails.id}: ${err.message}`,
              err.stack,
            );
          }
        }

        this.logger.log(
          `[MANUAL PHASE DETECTION] Completed processing for ${processedCount} open phase(s) requiring scorecards on challenge ${challengeDetails.id}`,
        );
      } else {
        this.logger.debug(
          `[MANUAL PHASE DETECTION] No open phases requiring scorecards found for challenge ${challengeDetails.id}`,
        );
      }

      try {
        await this.schedulerService.evaluateManualPhaseCompletion(
          challengeDetails,
        );
      } catch (error) {
        const err = error as Error;
        this.logger.error(
          `[MANUAL COMPLETION] Failed to evaluate manual completion for challenge ${challengeDetails.id}: ${err.message}`,
          err.stack,
        );
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Error handling challenge update: ${err.message}`,
        err.stack,
      );
    }
  }

  private resolveScorecardIdForOpenPhase(
    challenge: IChallenge,
    phase: IPhase,
  ): string | null {
    const phaseTemplateId = phase.phaseId;
    if (!phaseTemplateId) {
      return null;
    }

    if (SCREENING_PHASE_NAMES.has(phase.name)) {
      const configs = getReviewerConfigsForPhase(
        challenge.reviewers,
        phaseTemplateId,
      ).filter((config) => Boolean(config.scorecardId));

      if (!configs.length) {
        this.logger.debug(
          `No screening reviewer configs with scorecards found for challenge ${challenge.id}, phase ${phase.id}`,
        );
        return null;
      }

      const uniqueScorecards = Array.from(
        new Set(
          configs
            .map((config) => config.scorecardId)
            .filter((id): id is string => Boolean(id)),
        ),
      );

      if (uniqueScorecards.length > 1) {
        this.logger.warn(
          `Multiple screening scorecard IDs detected for challenge ${challenge.id}, phase ${phase.id}. Using ${uniqueScorecards[0]} for pending review updates.`,
        );
      }

      return uniqueScorecards[0] ?? null;
    }

    const reviewerConfigs = getMemberReviewerConfigs(
      challenge.reviewers,
      phaseTemplateId,
    ).filter((config) => Boolean(config.scorecardId));

    if (!reviewerConfigs.length) {
      this.logger.debug(
        `No member reviewer configs with scorecards found for challenge ${challenge.id}, phase ${phase.id}`,
      );
      return null;
    }

    const scorecardId = selectScorecardId(
      reviewerConfigs,
      () =>
        this.logger.warn(
          `Member reviewer configs missing scorecard IDs for challenge ${challenge.id}, phase ${phase.id}`,
        ),
      (choices) =>
        this.logger.warn(
          `Multiple scorecard IDs detected for challenge ${challenge.id}, phase ${phase.id}. Using ${choices[0]} for pending review updates.`,
        ),
    );

    return scorecardId ?? null;
  }

  private async updatePendingReviewScorecards(
    challengeId: string,
    phase: IPhase,
    scorecardId: string,
  ): Promise<void> {
    try {
      const updated = await this.reviewService.updatePendingReviewScorecards(
        challengeId,
        phase.id,
        scorecardId,
      );

      if (updated > 0) {
        this.logger.log(
          `[MANUAL PHASE DETECTION] Updated ${updated} pending review(s) for challenge ${challengeId}, phase ${phase.id} to scorecard ${scorecardId}`,
        );
      } else {
        this.logger.debug(
          `[MANUAL PHASE DETECTION] No pending reviews required scorecard updates for challenge ${challengeId}, phase ${phase.id}`,
        );
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `[MANUAL PHASE DETECTION] Failed to update pending reviews for challenge ${challengeId}, phase ${phase.id} to scorecard ${scorecardId}: ${err.message}`,
        err.stack,
      );
    }
  }

  async processPhaseChain(
    challengeId: string,
    projectId: number,
    projectStatus: string,
    nextPhases: IPhase[],
  ): Promise<void> {
    await this.openAndScheduleNextPhases(
      challengeId,
      projectId,
      projectStatus,
      nextPhases,
    );
  }

  async cancelAllPhasesForChallenge(challengeId: string): Promise<void> {
    const jobIds = this.schedulerService
      .getAllScheduledTransitions()
      .filter((jobId) => jobId.startsWith(`${challengeId}|`));

    for (const jobId of jobIds) {
      const [, phaseId] = jobId.split('|');
      if (phaseId) {
        await this.cancelPhaseTransition(challengeId, phaseId);
      }
    }
  }

  private async processPastDueOpenPhases(
    challenge: IChallenge,
  ): Promise<number> {
    const now = Date.now();

    const overduePhases = (challenge.phases ?? [])
      .filter((phase) => {
        if (!phase.isOpen || !phase.scheduledEndDate) {
          return false;
        }

        const scheduledEndTime = new Date(phase.scheduledEndDate).getTime();

        if (Number.isNaN(scheduledEndTime)) {
          return false;
        }

        if (scheduledEndTime >= now) {
          return false;
        }

        const ageMs = now - scheduledEndTime;
        if (ageMs < PhaseScheduleManager.OVERDUE_PHASE_GRACE_PERIOD_MS) {
          this.logger.debug(
            `Skipping immediate closure for phase ${phase.name} (${phase.id}) on challenge ${challenge.id}; overdue by ${ageMs} ms which is inside the ${PhaseScheduleManager.OVERDUE_PHASE_GRACE_PERIOD_MS} ms grace period.`,
          );
          return false;
        }

        return true;
      })
      .sort(
        (a, b) =>
          new Date(a.scheduledEndDate).getTime() -
          new Date(b.scheduledEndDate).getTime(),
      );

    if (overduePhases.length === 0) {
      return 0;
    }

    this.logger.log(
      `Detected ${overduePhases.length} open phase(s) with scheduled end in the past for challenge ${challenge.id}; attempting immediate processing.`,
    );

    let processedCount = 0;

    for (const phase of overduePhases) {
      try {
        const jobId = this.schedulerService.buildJobId(
          challenge.id,
          phase.id,
        );

        if (this.schedulerService.getScheduledTransition(jobId)) {
          const canceled =
            await this.schedulerService.cancelScheduledTransition(jobId);

          if (canceled) {
            this.logger.log(
              `Canceled outdated schedule ${jobId} before immediate close for challenge ${challenge.id}.`,
            );
          }
        }

        const payload: PhaseTransitionPayload = {
          projectId: challenge.projectId,
          challengeId: challenge.id,
          phaseId: phase.id,
          phaseTypeName: phase.name,
          state: 'END',
          operator: AutopilotOperator.SYSTEM_SYNC,
          projectStatus: challenge.status,
          date: new Date().toISOString(),
        };

        this.logger.log(
          `Attempting immediate closure for overdue phase ${phase.name} (${phase.id}) on challenge ${challenge.id}.`,
        );

        try {
          const latestPhase =
            await this.challengeApiService.getPhaseDetails(
              challenge.id,
              phase.id,
            );

          if (!latestPhase) {
            this.logger.warn(
              `Skipping overdue closure for phase ${phase.id} on challenge ${challenge.id}; phase details could not be retrieved.`,
            );
            continue;
          }

          if (!latestPhase.isOpen || latestPhase.actualEndDate) {
            this.logger.debug(
              `Skipping overdue closure for phase ${phase.name} (${phase.id}) on challenge ${challenge.id}; latest snapshot indicates it is no longer open.`,
            );
            continue;
          }
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Unable to verify latest status for phase ${phase.id} on challenge ${challenge.id} before overdue closure: ${err.message}`,
            err.stack,
          );
          continue;
        }

        await this.schedulerService.advancePhase(payload);
        processedCount += 1;
      } catch (error) {
        const err = error as Error;
        this.logger.error(
          `Failed immediate processing for phase ${phase.id} on challenge ${challenge.id}: ${err.message}`,
          err.stack,
        );
      }
    }

    return processedCount;
  }

  private async scheduleRelevantPhases(
    challenge: IChallenge,
    context: {
      operator: AutopilotOperator | string | undefined;
      schedulePhase: (payload: PhaseTransitionPayload) => Promise<unknown>;
      onNoPhases: () => void;
      onSuccess: (summaries: string[]) => void;
      onMissingScheduleData: () => void;
      onMissingDates: (phase: IPhase, stateLabel: 'start' | 'end') => void;
    },
  ): Promise<void> {
    const phasesToSchedule = this.findPhasesToSchedule(challenge.phases ?? []);

    if (phasesToSchedule.length === 0) {
      context.onNoPhases();
      return;
    }

    const now = new Date();
    const summaries: string[] = [];

    for (const nextPhase of phasesToSchedule) {
      const shouldOpen =
        !nextPhase.isOpen &&
        !nextPhase.actualEndDate &&
        nextPhase.scheduledStartDate &&
        new Date(nextPhase.scheduledStartDate).getTime() <= now.getTime();

      const state = shouldOpen ? 'START' : 'END';
      const scheduleDate = shouldOpen
        ? nextPhase.scheduledStartDate
        : nextPhase.scheduledEndDate;

      if (!scheduleDate) {
        context.onMissingDates(nextPhase, shouldOpen ? 'start' : 'end');
        continue;
      }

      const payload: PhaseTransitionPayload = {
        projectId: challenge.projectId,
        challengeId: challenge.id,
        phaseId: nextPhase.id,
        phaseTypeName: nextPhase.name,
        state,
        operator: context.operator ?? AutopilotOperator.SYSTEM,
        projectStatus: challenge.status,
        date: scheduleDate,
      };

      await context.schedulePhase(payload);
      summaries.push(
        `${nextPhase.name} (${nextPhase.id}) -> ${state} @ ${scheduleDate}`,
      );
    }

    if (summaries.length === 0) {
      context.onMissingScheduleData();
      return;
    }

    context.onSuccess(summaries);
  }

  getActiveSchedulesSnapshot(): Map<string, string> {
    const snapshot = new Map<string, string>();
    const scheduledJobs = this.schedulerService.getAllScheduledTransitions();

    for (const jobId of scheduledJobs) {
      const [challengeId, phaseId] = jobId.split('|');
      if (challengeId && phaseId) {
        snapshot.set(`${challengeId}:${phaseId}`, jobId);
      }
    }

    return snapshot;
  }

  private findPhasesToSchedule(phases: IPhase[]): IPhase[] {
    const now = new Date();

    const phasesToOpen = phases
      .filter((phase) => {
        if (phase.isOpen || phase.actualEndDate) {
          return false;
        }

        const startTime = new Date(phase.scheduledStartDate);
        if (startTime > now) {
          return false;
        }

        if (!phase.predecessor) {
          return true;
        }

        const predecessor = phases.find(
          (p) => p.phaseId === phase.predecessor || p.id === phase.predecessor,
        );

        return Boolean(predecessor?.actualEndDate);
      })
      .sort(
        (a, b) =>
          new Date(a.scheduledStartDate).getTime() -
          new Date(b.scheduledStartDate).getTime(),
      );

    if (phasesToOpen.length > 0) {
      return phasesToOpen;
    }

    const openPhases = phases
      .filter((phase) => phase.isOpen)
      .sort(
        (a, b) =>
          new Date(a.scheduledEndDate).getTime() -
          new Date(b.scheduledEndDate).getTime(),
      );

    if (openPhases.length > 0) {
      return openPhases;
    }

    const futurePhases = phases.filter(
      (phase) =>
        !phase.actualStartDate &&
        !phase.actualEndDate &&
        phase.scheduledStartDate &&
        new Date(phase.scheduledStartDate) > now,
    );

    const readyPhases = futurePhases.filter((phase) => {
      if (!phase.predecessor) {
        return true;
      }

      const predecessor = phases.find(
        (p) => p.phaseId === phase.predecessor || p.id === phase.predecessor,
      );

      return Boolean(predecessor?.actualEndDate);
    });

    if (readyPhases.length === 0) {
      return [];
    }

    const sortedReady = readyPhases.sort(
      (a, b) =>
        new Date(a.scheduledStartDate).getTime() -
        new Date(b.scheduledStartDate).getTime(),
    );

    const earliest = new Date(sortedReady[0].scheduledStartDate).getTime();

    return sortedReady.filter(
      (phase) => new Date(phase.scheduledStartDate).getTime() === earliest,
    );
  }

  private async openAndScheduleNextPhases(
    challengeId: string,
    projectId: number,
    projectStatus: string,
    nextPhases: IPhase[],
  ): Promise<void> {
    if (!isActiveStatus(projectStatus)) {
      this.logger.log(
        `[PHASE CHAIN] Challenge ${challengeId} is not ACTIVE (status: ${projectStatus}), skipping phase chain processing.`,
      );
      return;
    }

    if (!nextPhases || nextPhases.length === 0) {
      this.logger.log(
        `[PHASE CHAIN] No next phases to open for challenge ${challengeId}`,
      );
      return;
    }

    this.logger.log(
      `[PHASE CHAIN] Opening and scheduling ${nextPhases.length} next phases for challenge ${challengeId}`,
    );

    let processedCount = 0;
    let deferredCount = 0;

    for (const nextPhase of nextPhases) {
      const openPhaseCallback = async () =>
        await this.openPhaseAndSchedule(
          challengeId,
          projectId,
          projectStatus,
          nextPhase,
        );

      try {
        const canOpenNow =
          await this.reviewAssignmentService.ensureAssignmentsOrSchedule(
            challengeId,
            nextPhase,
            openPhaseCallback,
          );

        if (!canOpenNow) {
          deferredCount++;
          continue;
        }

        const opened = await openPhaseCallback();
        if (opened) {
          processedCount++;
        }
      } catch (error) {
        const err = error as Error;
        this.logger.error(
          `[PHASE CHAIN] Failed to open and schedule phase ${nextPhase.name} (${nextPhase.id}) for challenge ${challengeId}: ${err.message}`,
          err.stack,
        );
      }
    }

    const summaryParts = [
      `opened and scheduled ${processedCount} out of ${nextPhases.length}`,
    ];
    if (deferredCount > 0) {
      summaryParts.push(
        `deferred ${deferredCount} awaiting reviewer assignments`,
      );
    }

    this.logger.log(
      `[PHASE CHAIN] ${summaryParts.join(', ')} for challenge ${challengeId}`,
    );
  }

  private async openPhaseAndSchedule(
    challengeId: string,
    projectId: number,
    projectStatus: string,
    phase: IPhase,
  ): Promise<boolean> {
    if (!isActiveStatus(projectStatus)) {
      this.logger.log(
        `[PHASE CHAIN] Challenge ${challengeId} is not ACTIVE (status: ${projectStatus}); skipping phase ${phase.name} (${phase.id}).`,
      );
      return false;
    }

    this.logger.log(
      `[PHASE CHAIN] Opening phase ${phase.name} (${phase.id}) for challenge ${challengeId}`,
    );

    const openResult = await this.challengeApiService.advancePhase(
      challengeId,
      phase.id,
      'open',
    );

    if (!openResult.success) {
      this.logger.error(
        `[PHASE CHAIN] Failed to open phase ${phase.name} (${phase.id}) for challenge ${challengeId}: ${openResult.message}`,
      );
      return false;
    }

    this.reviewAssignmentService.clearPolling(challengeId, phase.id);

    this.logger.log(
      `[PHASE CHAIN] Successfully opened phase ${phase.name} (${phase.id}) for challenge ${challengeId}`,
    );

    // Create pending reviews for any review-related phases (Review, Screening, Approval).
    // PhaseReviewService will ignore non review phases.
    try {
      await this.phaseReviewService.handlePhaseOpened(challengeId, phase.id);
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `[PHASE CHAIN] Failed to prepare review records for phase ${phase.name} (${phase.id}) on challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
    }

    const updatedPhase =
      openResult.updatedPhases?.find((p) => p.id === phase.id) || phase;

    if (!updatedPhase.scheduledEndDate) {
      this.logger.warn(
        `[PHASE CHAIN] Opened phase ${phase.name} (${phase.id}) has no scheduled end date, skipping scheduling`,
      );
      return false;
    }

    if (this.isAppealsResponsePhaseName(updatedPhase.name)) {
      try {
        const totalAppeals =
          await this.reviewService.getTotalAppealCount(challengeId);

        if (totalAppeals === 0) {
          this.logger.log(
            `[APPEALS RESPONSE] No appeals detected for challenge ${challengeId}; closing phase ${updatedPhase.id} immediately after open.`,
          );

          const closePayload: PhaseTransitionPayload = {
            projectId,
            challengeId,
            phaseId: updatedPhase.id,
            phaseTypeName: updatedPhase.name,
            state: 'END',
            operator: AutopilotOperator.SYSTEM_PHASE_CHAIN,
            projectStatus,
            date: new Date().toISOString(),
          };

          await this.schedulerService.advancePhase(closePayload);
          return true;
        }
      } catch (error) {
        const err = error as Error;
        this.logger.error(
          `[APPEALS RESPONSE] Unable to auto-close phase ${updatedPhase.id} for challenge ${challengeId}: ${err.message}`,
          err.stack,
        );
      }
    }

    const existingJobId = this.schedulerService.buildJobId(
      challengeId,
      phase.id,
    );
    if (this.schedulerService.getScheduledTransition(existingJobId)) {
      this.logger.log(
        `[PHASE CHAIN] Phase ${phase.name} (${phase.id}) is already scheduled, skipping`,
      );
      return false;
    }

    const nextPhaseData: PhaseTransitionPayload = {
      projectId,
      challengeId,
      phaseId: updatedPhase.id,
      phaseTypeName: updatedPhase.name,
      state: 'END',
      operator: AutopilotOperator.SYSTEM_PHASE_CHAIN,
      projectStatus,
      date: updatedPhase.scheduledEndDate,
    };

    const scheduledJobId = await this.schedulePhaseTransition(nextPhaseData);
    this.logger.log(
      `[PHASE CHAIN] Scheduled opened phase ${updatedPhase.name} (${updatedPhase.id}) for closure at ${updatedPhase.scheduledEndDate} with job ID: ${scheduledJobId}`,
    );
    return true;
  }

  // isActiveStatus utility now centralizes active-status checks

  private isAppealsResponsePhaseName(
    phaseName?: string | null,
  ): boolean {
    const normalized = phaseName?.trim();
    if (!normalized) {
      return false;
    }

    return this.appealsResponsePhaseNames.has(normalized);
  }
}
