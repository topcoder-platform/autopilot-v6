import type { AutopilotService } from '../autopilot/services/autopilot.service';
import type { SchedulerService } from '../autopilot/services/scheduler.service';
import type { ChallengeApiService } from '../challenge/challenge-api.service';
import { AutopilotOperator } from '../autopilot/interfaces/autopilot.interface';
import { RecoveryService } from './recovery.service';

describe('RecoveryService', () => {
  let autopilotService: {
    handleChallengeUpdate: jest.Mock;
    schedulePhaseTransition: jest.Mock;
  };
  let challengeApiService: {
    getAllActiveChallenges: jest.Mock;
  };
  let schedulerService: {
    triggerKafkaEvent: jest.Mock;
  };
  let service: RecoveryService;

  beforeEach(() => {
    autopilotService = {
      handleChallengeUpdate: jest.fn().mockResolvedValue(undefined),
      schedulePhaseTransition: jest.fn().mockResolvedValue('job-id'),
    };
    challengeApiService = {
      getAllActiveChallenges: jest.fn().mockResolvedValue([]),
    };
    schedulerService = {
      triggerKafkaEvent: jest.fn().mockResolvedValue(undefined),
    };

    service = new RecoveryService(
      autopilotService as unknown as AutopilotService,
      challengeApiService as unknown as ChallengeApiService,
      schedulerService as unknown as SchedulerService,
    );
  });

  it('replays already-open Review phases through challenge update handling during recovery', async () => {
    challengeApiService.getAllActiveChallenges.mockResolvedValue([
      {
        id: 'challenge-mm',
        projectId: 1001,
        status: 'ACTIVE',
        phases: [
          {
            id: 'phase-review',
            phaseId: 'review-template',
            name: 'Review',
            isOpen: true,
            scheduledStartDate: '2026-05-01T00:00:00.000Z',
            scheduledEndDate: '2026-05-02T00:00:00.000Z',
            actualStartDate: '2026-05-01T00:05:00.000Z',
            actualEndDate: null,
            predecessor: 'phase-submission',
          },
        ],
      },
    ]);

    await service.onApplicationBootstrap();

    expect(autopilotService.handleChallengeUpdate).toHaveBeenCalledWith({
      id: 'challenge-mm',
      projectId: 1001,
      status: 'ACTIVE',
      operator: AutopilotOperator.SYSTEM_RECOVERY,
    });
    expect(autopilotService.schedulePhaseTransition).not.toHaveBeenCalled();
    expect(schedulerService.triggerKafkaEvent).not.toHaveBeenCalled();
  });
});
