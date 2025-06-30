/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PhaseTransitionPayload } from '../autopilot/interfaces/autopilot.interface';
import { AutopilotService } from '../autopilot/services/autopilot.service';
import { ChallengeService, IPhase } from '../challenge/challenge.service';

@Injectable()
export class RecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    private readonly autopilotService: AutopilotService,
    private readonly challengeApiService: ChallengeService, // You'll need to mock or implement this
  ) {}

  async onApplicationBootstrap() {
    this.logger.log('Starting recovery process...');

    try {
      const activePhases: IPhase[] = this.challengeApiService.getActivePhases();

      for (const phase of activePhases) {
        const endTime = new Date(phase.date).getTime();
        const now = Date.now();

        const phaseData: PhaseTransitionPayload = {
          projectId: phase.projectId,
          phaseId: phase.id,
          phaseTypeName: phase.phaseTypeName,
          state: 'END',
          operator: 'system-recovery',
          projectStatus: 'IN_PROGRESS',
          date: phase.date,
        };

        if (endTime <= now) {
          this.logger.warn(
            `Phase ${phase.id} already ended — processing immediately`,
          );
          await this.autopilotService.handlePhaseTransition(phaseData);
        } else {
          this.autopilotService.schedulePhaseTransition(phaseData);
        }
      }

      this.logger.log(
        `Recovery process completed for ${activePhases.length} phases.`,
      );
    } catch (error) {
      this.logger.error('Recovery failed:', error.stack || error.message);
    }
  }
}
