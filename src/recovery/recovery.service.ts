import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PhaseTransitionPayload } from '../autopilot/interfaces/autopilot.interface';
import { AutopilotService } from '../autopilot/services/autopilot.service';
import { ChallengeApiService } from '../challenge/challenge-api.service';
import { IChallenge } from '../challenge/interfaces/challenge.interface';
import { SchedulerService } from '../autopilot/services/scheduler.service';

@Injectable()
export class RecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    private readonly autopilotService: AutopilotService,
    private readonly challengeApiService: ChallengeApiService,
    private readonly schedulerService: SchedulerService,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log('Starting recovery process...');

    try {
      const activeChallenges: IChallenge[] =
        await this.challengeApiService.getAllActiveChallenges({
          status: 'ACTIVE',
        });

      // Corrected: Add a guard clause to prevent crash if API returns undefined or null
      if (!activeChallenges) {
        this.logger.warn(
          'Received no active challenges from API. Skipping recovery.',
        );
        return;
      }

      this.logger.log(
        `Found ${activeChallenges.length} active challenges to process for recovery.`,
      );

      for (const challenge of activeChallenges) {
        if (!challenge.phases || challenge.phases.length === 0) {
          this.logger.warn(
            `Challenge ${challenge.id} has no phases to schedule.`,
            { projectId: challenge.projectId },
          );
          continue;
        }

        for (const phase of challenge.phases) {
          const phaseEndDate = phase.scheduledEndDate;
          if (!phaseEndDate) {
            this.logger.warn(
              `Phase ${phase.id} for challenge ${challenge.id} has no scheduled end date. Skipping.`,
              { phaseName: phase.name },
            );
            continue;
          }
          const endTime = new Date(phaseEndDate).getTime();
          const now = Date.now();

          const phaseData: PhaseTransitionPayload = {
            projectId: challenge.projectId,
            challengeId: challenge.id,
            phaseId: phase.id,
            phaseTypeName: phase.name,
            state: 'END',
            operator: 'system-recovery',
            projectStatus: challenge.status,
            date: phaseEndDate,
          };

          if (endTime <= now) {
            this.logger.warn(
              `Phase ${phase.id} for challenge ${challenge.id} already ended — triggering immediate Kafka event`,
            );
            await this.schedulerService.triggerKafkaEvent(phaseData);
          } else {
            this.autopilotService.schedulePhaseTransition(phaseData);
          }
        }
      }

      this.logger.log(
        `Recovery process completed for ${activeChallenges.length} challenges.`,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error('Recovery process failed:', err.stack || err.message);
    }
  }
}
