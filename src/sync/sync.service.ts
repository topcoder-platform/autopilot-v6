import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AutopilotService } from '../autopilot/services/autopilot.service';
import { ChallengeApiService } from '../challenge/challenge-api.service';
import { SchedulerService } from '../autopilot/services/scheduler.service';
import {
  PhaseTransitionPayload,
  AutopilotOperator,
} from '../autopilot/interfaces/autopilot.interface';
import { IChallenge } from '../challenge/interfaces/challenge.interface';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private static readonly PAYABLE_CHALLENGE_STATUSES = [
    'COMPLETED',
    'CANCELLED_FAILED_REVIEW',
  ] as const;
  private static readonly PAYABLE_CHALLENGE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
  private static readonly PAYABLE_CHALLENGE_PAGE_SIZE = 200;

  constructor(
    private readonly autopilotService: AutopilotService,
    private readonly challengeApiService: ChallengeApiService,
    private readonly schedulerService: SchedulerService,
  ) {}

  // Run sync every 3 minutes instead of 5
  @Cron('*/3 * * * *')
  async handleCron() {
    this.logger.log('Running scheduled challenge synchronization...');
    await this.synchronizeChallenges();
  }

  async synchronizeChallenges() {
    try {
      // New: Counters for summary logging
      let added = 0;
      let updated = 0;
      let removed = 0;
      let payableReplayed = 0;

      const activeChallenges =
        await this.challengeApiService.getAllActiveChallenges({
          status: 'ACTIVE',
        });

      const scheduledJobs =
        this.schedulerService.getAllScheduledTransitionsWithData();
      const scheduledJobIds = new Set(scheduledJobs.keys());

      const activeJobIds = new Set<string>();
      const now = new Date();

      // 1. Add/update schedules for active challenges
      for (const challenge of activeChallenges) {
        if (!challenge.phases) continue;

        for (const phase of challenge.phases) {
          // Skip phases that have already ended
          if (phase.actualEndDate) {
            continue;
          }

          // Determine what to schedule based on phase state
          let scheduleDate: string | undefined;
          let state: 'START' | 'END';

          if (!phase.isOpen && !phase.actualStartDate) {
            // Phase hasn't started yet
            const startTime = new Date(phase.scheduledStartDate);

            // Check if it's time to start or should be scheduled for future start
            if (startTime <= now) {
              // Check predecessor requirements
              if (phase.predecessor) {
                const predecessor = challenge.phases.find(
                  (p) =>
                    p.phaseId === phase.predecessor ||
                    p.id === phase.predecessor,
                );
                if (!predecessor || !predecessor.actualEndDate) {
                  // Predecessor hasn't ended yet, skip this phase
                  continue;
                }
              }
              // Should start now or soon
              scheduleDate = phase.scheduledStartDate;
              state = 'START';
            } else {
              // Future phase - don't schedule yet, will be handled when predecessor ends
              continue;
            }
          } else if (phase.isOpen) {
            // Phase is currently open, schedule for end
            scheduleDate = phase.scheduledEndDate;
            state = 'END';
          } else {
            // Phase is closed but not ended (shouldn't happen in normal flow)
            continue;
          }

          if (!scheduleDate) continue;

          const phaseKey = `${challenge.id}:${phase.id}`;
          const jobId = this.schedulerService.buildJobId(challenge.id, phase.id);
          activeJobIds.add(jobId);

          const scheduledJob = scheduledJobs.get(jobId);

          const phaseData: PhaseTransitionPayload = {
            projectId: challenge.projectId,
            challengeId: challenge.id,
            phaseId: phase.id,
            phaseTypeName: phase.name,
            state,
            operator: AutopilotOperator.SYSTEM_SYNC,
            projectStatus: challenge.status,
            date: scheduleDate,
          };

          if (!scheduledJob) {
            this.logger.log(
              `New active phase found: ${phaseKey} (${state}). Scheduling for ${scheduleDate}...`,
            );
            await this.autopilotService.schedulePhaseTransition(phaseData);
            added++;
          } else if (
            scheduledJob.date &&
            (new Date(scheduledJob.date).getTime() !==
              new Date(scheduleDate).getTime() ||
              scheduledJob.state !== state)
          ) {
            this.logger.log(
              `Phase ${phaseKey} has updated timing or state. Rescheduling from ${scheduledJob.state} at ${scheduledJob.date} to ${state} at ${scheduleDate}...`,
            );
            await this.autopilotService.reschedulePhaseTransition(
              challenge.id,
              phaseData,
            );
            updated++;
          }
        }
      }

      // 2. Remove obsolete schedules
      for (const scheduledJobId of scheduledJobIds) {
        if (!activeJobIds.has(scheduledJobId)) {
          this.logger.log(
            `Obsolete schedule found: ${scheduledJobId}. Cancelling...`,
          );

          const parsedJob = this.parseScheduledJobId(scheduledJobId);
          if (!parsedJob) {
            this.logger.warn(
              `Unable to parse scheduled job ID ${scheduledJobId}; skipping cancellation.`,
            );
            continue;
          }

          await this.autopilotService.cancelPhaseTransition(
            parsedJob.challengeId,
            parsedJob.phaseId,
          );
          removed++;
        }
      }

      payableReplayed = await this.reconcileRecentPayableChallenges();

      // New: Summary log
      this.logger.log(
        `Challenge synchronization completed. Added: ${added}, Updated: ${updated}, Removed: ${removed}, Payable replayed: ${payableReplayed}.`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error('Challenge synchronization failed', err.stack);
    }
  }

  private parseScheduledJobId(
    jobId: string,
  ): { challengeId: string; phaseId: string } | null {
    if (!jobId) {
      return null;
    }

    const delimiter = jobId.includes('|')
      ? '|'
      : jobId.includes(':')
        ? ':'
        : null;

    if (!delimiter) {
      return null;
    }

    const [challengeId, phaseId] = jobId.split(delimiter);
    if (!challengeId || !phaseId) {
      return null;
    }

    return { challengeId, phaseId };
  }

  /**
   * Returns true when a challenge update timestamp falls within the payable
   * reconciliation lookback window.
   *
   * @param challenge challenge snapshot from the Challenge API
   * @param now current timestamp used for comparison
   * @returns true if the challenge was updated recently enough to reconcile
   */
  private isWithinPayableLookback(challenge: IChallenge, now: Date): boolean {
    const updatedAtMs = new Date(challenge.updated).getTime();
    if (!Number.isFinite(updatedAtMs)) {
      return false;
    }

    return (
      now.getTime() - updatedAtMs <= SyncService.PAYABLE_CHALLENGE_LOOKBACK_MS
    );
  }

  /**
   * Replays recent payable-status challenges through the regular challenge
   * update handler so finance generation can still occur when Kafka update
   * events are missed or delayed.
   *
   * @returns number of payable challenges replayed
   */
  private async reconcileRecentPayableChallenges(): Promise<number> {
    const now = new Date();
    let replayed = 0;

    for (const status of SyncService.PAYABLE_CHALLENGE_STATUSES) {
      let challenges: IChallenge[] = [];

      try {
        challenges = await this.challengeApiService.getAllActiveChallenges({
          status,
          page: 1,
          perPage: SyncService.PAYABLE_CHALLENGE_PAGE_SIZE,
        });
      } catch (error) {
        const err = error as Error;
        this.logger.error(
          `[FINANCE RECONCILIATION] Failed to fetch ${status} challenges: ${err.message}`,
          err.stack,
        );
        continue;
      }

      const recentChallenges = challenges.filter((challenge) =>
        this.isWithinPayableLookback(challenge, now),
      );

      if (!recentChallenges.length) {
        continue;
      }

      this.logger.log(
        `[FINANCE RECONCILIATION] Replaying ${recentChallenges.length} recent ${status} challenge update(s).`,
      );

      for (const challenge of recentChallenges) {
        try {
          await this.autopilotService.handleChallengeUpdate({
            id: challenge.id,
            projectId: challenge.projectId,
            status: challenge.status,
            operator: AutopilotOperator.SYSTEM_SYNC,
          });
          replayed++;
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `[FINANCE RECONCILIATION] Failed to replay challenge update for ${challenge.id}: ${err.message}`,
            err.stack,
          );
        }
      }
    }

    return replayed;
  }
}
