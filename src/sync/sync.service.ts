import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AutopilotService } from '../autopilot/services/autopilot.service';
import { ChallengeApiService } from '../challenge/challenge-api.service';
import { SchedulerService } from '../autopilot/services/scheduler.service';
import {
  PhaseTransitionPayload,
  AutopilotOperator,
} from '../autopilot/interfaces/autopilot.interface';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

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

      const activeChallenges =
        await this.challengeApiService.getAllActiveChallenges({
          status: 'ACTIVE',
        });

      const scheduledJobs =
        this.schedulerService.getAllScheduledTransitionsWithData();
      const scheduledPhaseKeys = new Set(scheduledJobs.keys());

      const activePhaseKeys = new Set<string>();
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
          activePhaseKeys.add(phaseKey);

          const scheduledJob = scheduledJobs.get(phaseKey);

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
      for (const scheduledPhaseKey of scheduledPhaseKeys) {
        if (!activePhaseKeys.has(scheduledPhaseKey)) {
          this.logger.log(
            `Obsolete schedule found: ${scheduledPhaseKey}. Cancelling...`,
          );
          const [challengeId, phaseId] = scheduledPhaseKey.split(':');
          await this.autopilotService.cancelPhaseTransition(
            challengeId,
            phaseId,
          );
          removed++;
        }
      }

      // New: Summary log
      this.logger.log(
        `Challenge synchronization completed. Added: ${added}, Updated: ${updated}, Removed: ${removed}.`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error('Challenge synchronization failed', err.stack);
    }
  }
}
