import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AutopilotService } from '../autopilot/services/autopilot.service';
import { ChallengeApiService } from '../challenge/challenge-api.service';
import { SchedulerService } from '../autopilot/services/scheduler.service';
import { PhaseTransitionPayload } from '../autopilot/interfaces/autopilot.interface';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly autopilotService: AutopilotService,
    private readonly challengeApiService: ChallengeApiService,
    private readonly schedulerService: SchedulerService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
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

      // 1. Add/update schedules for active challenges
      for (const challenge of activeChallenges) {
        if (!challenge.phases) continue;

        for (const phase of challenge.phases) {
          const phaseEndDate = phase.scheduledEndDate;
          if (!phaseEndDate) continue;

          const phaseKey = `${challenge.projectId}:${phase.id}`;
          activePhaseKeys.add(phaseKey);

          const scheduledJob = scheduledJobs.get(phaseKey);

          const phaseData: PhaseTransitionPayload = {
            projectId: challenge.projectId,
            challengeId: challenge.id,
            phaseId: phase.id,
            phaseTypeName: phase.name,
            state: 'END',
            operator: 'system-sync',
            projectStatus: challenge.status,
            date: phaseEndDate,
          };

          if (!scheduledJob) {
            this.logger.log(
              `New active phase found: ${phaseKey}. Scheduling...`,
            );
            this.autopilotService.schedulePhaseTransition(phaseData);
            added++;
          } else if (
            scheduledJob.date &&
            new Date(scheduledJob.date).getTime() !==
              new Date(phaseEndDate).getTime()
          ) {
            this.logger.log(
              `Phase ${phaseKey} has updated timing. Rescheduling...`,
            );
            void this.autopilotService.reschedulePhaseTransition(
              challenge.projectId,
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
          const [projectId, phaseId] = scheduledPhaseKey.split(':');
          this.autopilotService.cancelPhaseTransition(
            parseInt(projectId, 10),
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
