import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import {
  PhaseTransitionPayload,
  AutopilotOperator,
} from '../autopilot/interfaces/autopilot.interface';
import { AutopilotService } from '../autopilot/services/autopilot.service';
import { ChallengeApiService } from '../challenge/challenge-api.service';
import {
  IChallenge,
  IPhase,
} from '../challenge/interfaces/challenge.interface';
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
      // const activeChallenges: IChallenge[] =
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

        // Process all phases that need to be scheduled or triggered
        const phasesToProcess = this.findAllPhasesToProcess(challenge.phases);

        if (phasesToProcess.length === 0) {
          this.logger.log(
            `No phases need to be processed for challenge ${challenge.id}`,
            { projectId: challenge.projectId },
          );
          continue;
        }

        const currentTime = new Date();

        for (const phaseInfo of phasesToProcess) {
          const { phase, action } = phaseInfo;

          // Determine schedule date and state based on action
          let scheduleDate: string;
          let state: 'START' | 'END';

          if (action === 'start') {
            scheduleDate = phase.scheduledStartDate;
            state = 'START';
          } else {
            scheduleDate = phase.scheduledEndDate;
            state = 'END';
          }

          if (!scheduleDate) {
            this.logger.warn(
              `Phase ${phase.id} for challenge ${challenge.id} has no scheduled ${action === 'start' ? 'start' : 'end'} date. Skipping.`,
              { phaseName: phase.name },
            );
            continue;
          }

          const phaseData: PhaseTransitionPayload = {
            projectId: challenge.projectId,
            challengeId: challenge.id,
            phaseId: phase.id,
            phaseTypeName: phase.name,
            state,
            operator: AutopilotOperator.SYSTEM_RECOVERY,
            projectStatus: challenge.status,
            date: scheduleDate,
          };

          const scheduleTime = new Date(scheduleDate).getTime();
          if (scheduleTime <= currentTime.getTime()) {
            this.logger.warn(
              `Phase ${phase.id} (${phase.name}) for challenge ${challenge.id} should have ${action === 'start' ? 'started' : 'ended'} — triggering immediate Kafka event`,
            );
            await this.schedulerService.triggerKafkaEvent(phaseData);
          } else {
            this.logger.log(
              `Scheduling phase ${phase.name} (${phase.id}) for challenge ${challenge.id} to ${state} at ${scheduleDate}`,
            );
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

  /**
   * Find all phases that should be processed during recovery.
   * Returns phases with their required action (start or end).
   */
  private findAllPhasesToProcess(
    phases: IPhase[],
  ): Array<{ phase: IPhase; action: 'start' | 'end' }> {
    const phasesToProcess: Array<{ phase: IPhase; action: 'start' | 'end' }> =
      [];
    const now = new Date();

    for (const phase of phases) {
      // Skip phases that have already ended
      if (phase.actualEndDate) {
        continue;
      }

      // Check if phase should be started
      if (!phase.isOpen && !phase.actualStartDate) {
        const startTime = new Date(phase.scheduledStartDate);

        // Check if it's time to start
        if (startTime <= now) {
          // Check predecessor requirements
          if (phase.predecessor) {
            const predecessor = phases.find(
              (p) =>
                p.phaseId === phase.predecessor || p.id === phase.predecessor,
            );
            if (!predecessor || !predecessor.actualEndDate) {
              // Predecessor hasn't ended yet, skip this phase
              continue;
            }
          }
          // Phase should be started
          phasesToProcess.push({ phase, action: 'start' });
        }
      }
      // Check if phase should be ended
      else if (phase.isOpen) {
        // Phase is open, should only be scheduled to end if it hasn't been scheduled yet
        // The scheduler will handle it when the time comes
        // For recovery, we only care about overdue phases
        const endTime = new Date(phase.scheduledEndDate);
        if (endTime <= now) {
          // Phase is overdue and should end immediately
          phasesToProcess.push({ phase, action: 'end' });
        }
        // Don't schedule future END transitions here - let sync service handle that
      }
    }

    return phasesToProcess;
  }

  /**
   * Find the next phase that should be processed during recovery.
   * Similar logic to AutopilotService but also handles overdue phases.
   * @deprecated Use findAllPhasesToProcess instead
   */
  private findNextPhaseToProcess(phases: IPhase[]): IPhase | null {
    const now = new Date();

    // First, check for overdue phases (phases that should have ended but are still open)
    const overduePhases = phases.filter(
      (phase) =>
        phase.isOpen &&
        phase.scheduledEndDate &&
        !phase.actualEndDate &&
        new Date(phase.scheduledEndDate).getTime() <= now.getTime(),
    );

    if (overduePhases.length > 0) {
      // Return the earliest overdue phase
      return overduePhases.sort(
        (a, b) =>
          new Date(a.scheduledEndDate).getTime() -
          new Date(b.scheduledEndDate).getTime(),
      )[0];
    }

    // Second, check for phases that should be open but aren't
    const phasesToOpen = phases.filter((phase) => {
      if (phase.isOpen || phase.actualEndDate) {
        return false; // Already open or already ended
      }

      const startTime = new Date(phase.scheduledStartDate);
      if (startTime > now) {
        return false; // Not time to start yet
      }

      // Check if predecessor requirements are met
      if (!phase.predecessor) {
        return true; // No predecessor, ready to start
      }

      const predecessor = phases.find(
        (p) => p.phaseId === phase.predecessor || p.id === phase.predecessor,
      );
      return Boolean(predecessor?.actualEndDate); // Predecessor has ended
    });

    if (phasesToOpen.length > 0) {
      // Return the earliest phase that should be opened
      return phasesToOpen.sort(
        (a, b) =>
          new Date(a.scheduledStartDate).getTime() -
          new Date(b.scheduledStartDate).getTime(),
      )[0];
    }

    // Third, find currently open phases that haven't ended yet
    const openPhases = phases.filter(
      (phase) =>
        phase.isOpen &&
        phase.scheduledEndDate &&
        new Date(phase.scheduledEndDate).getTime() > now.getTime(),
    );

    if (openPhases.length > 0) {
      // Return the earliest ending open phase
      return openPhases.sort(
        (a, b) =>
          new Date(a.scheduledEndDate).getTime() -
          new Date(b.scheduledEndDate).getTime(),
      )[0];
    }

    // Finally, look for future phases that need to be scheduled
    const futurePhases = phases.filter(
      (phase) =>
        !phase.actualStartDate && // hasn't started yet
        !phase.actualEndDate && // hasn't ended yet
        phase.scheduledStartDate && // has a scheduled start date
        new Date(phase.scheduledStartDate) > now, // starts in the future
    );

    if (futurePhases.length === 0) {
      return null;
    }

    // Find phases that are ready to start (no predecessor or predecessor is closed)
    const readyPhases = futurePhases.filter((phase) => {
      if (!phase.predecessor) {
        return true; // No predecessor, ready to start
      }

      // Check if predecessor has ended
      const predecessor = phases.find(
        (p) => p.phaseId === phase.predecessor || p.id === phase.predecessor,
      );
      return Boolean(predecessor?.actualEndDate);
    });

    if (readyPhases.length === 0) {
      return null;
    }

    // Return the earliest scheduled phase
    return readyPhases.sort(
      (a, b) =>
        new Date(a.scheduledStartDate).getTime() -
        new Date(b.scheduledStartDate).getTime(),
    )[0];
  }
}
