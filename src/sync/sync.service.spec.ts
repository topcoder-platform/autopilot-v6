import { AutopilotOperator } from '../autopilot/interfaces/autopilot.interface';
import { SyncService } from './sync.service';

describe('SyncService', () => {
  let service: SyncService;
  let autopilotService: {
    schedulePhaseTransition: jest.Mock;
    reschedulePhaseTransition: jest.Mock;
    cancelPhaseTransition: jest.Mock;
    handleChallengeUpdate: jest.Mock;
  };
  let challengeApiService: {
    getAllActiveChallenges: jest.Mock;
  };
  let schedulerService: {
    getAllScheduledTransitionsWithData: jest.Mock;
    buildJobId: jest.Mock;
  };

  beforeEach(() => {
    autopilotService = {
      schedulePhaseTransition: jest.fn(),
      reschedulePhaseTransition: jest.fn(),
      cancelPhaseTransition: jest.fn(),
      handleChallengeUpdate: jest.fn().mockResolvedValue(undefined),
    };

    challengeApiService = {
      getAllActiveChallenges: jest.fn(),
    };

    schedulerService = {
      getAllScheduledTransitionsWithData: jest.fn().mockReturnValue(new Map()),
      buildJobId: jest
        .fn()
        .mockImplementation((challengeId: string, phaseId: string) => {
          return `${challengeId}|${phaseId}`;
        }),
    };

    service = new SyncService(
      autopilotService as any,
      challengeApiService as any,
      schedulerService as any,
    );
  });

  it('replays recent payable challenges through challenge update handling', async () => {
    const nowIso = new Date().toISOString();

    challengeApiService.getAllActiveChallenges.mockImplementation(
      ({ status }: { status?: string }) => {
        if (status === 'ACTIVE') {
          return [];
        }

        if (status === 'COMPLETED') {
          return [
            {
              id: 'completed-1',
              projectId: 1001,
              status: 'COMPLETED',
              updated: nowIso,
            },
          ];
        }

        if (status === 'CANCELLED_FAILED_REVIEW') {
          return [
            {
              id: 'cfr-1',
              projectId: 1002,
              status: 'CANCELLED_FAILED_REVIEW',
              updated: nowIso,
            },
          ];
        }

        return [];
      },
    );

    await service.synchronizeChallenges();

    expect(autopilotService.handleChallengeUpdate).toHaveBeenCalledTimes(2);
    expect(autopilotService.handleChallengeUpdate).toHaveBeenNthCalledWith(1, {
      id: 'completed-1',
      projectId: 1001,
      status: 'COMPLETED',
      operator: AutopilotOperator.SYSTEM_SYNC,
    });
    expect(autopilotService.handleChallengeUpdate).toHaveBeenNthCalledWith(2, {
      id: 'cfr-1',
      projectId: 1002,
      status: 'CANCELLED_FAILED_REVIEW',
      operator: AutopilotOperator.SYSTEM_SYNC,
    });
  });

  it('skips payable challenges outside the reconciliation lookback window', async () => {
    const staleIso = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();

    challengeApiService.getAllActiveChallenges.mockImplementation(
      ({ status }: { status?: string }) => {
        if (status === 'ACTIVE') {
          return [];
        }

        if (status === 'COMPLETED') {
          return [
            {
              id: 'completed-stale',
              projectId: 1003,
              status: 'COMPLETED',
              updated: staleIso,
            },
          ];
        }

        return [];
      },
    );

    await service.synchronizeChallenges();

    expect(autopilotService.handleChallengeUpdate).not.toHaveBeenCalled();
  });

  it('continues reconciliation when one payable status query fails', async () => {
    const nowIso = new Date().toISOString();

    challengeApiService.getAllActiveChallenges.mockImplementation(
      ({ status }: { status?: string }) => {
        if (status === 'ACTIVE') {
          return [];
        }

        if (status === 'COMPLETED') {
          throw new Error('temporary db issue');
        }

        if (status === 'CANCELLED_FAILED_REVIEW') {
          return [
            {
              id: 'cfr-replay',
              projectId: 1004,
              status: 'CANCELLED_FAILED_REVIEW',
              updated: nowIso,
            },
          ];
        }

        return [];
      },
    );

    await service.synchronizeChallenges();

    expect(autopilotService.handleChallengeUpdate).toHaveBeenCalledTimes(1);
    expect(autopilotService.handleChallengeUpdate).toHaveBeenCalledWith({
      id: 'cfr-replay',
      projectId: 1004,
      status: 'CANCELLED_FAILED_REVIEW',
      operator: AutopilotOperator.SYSTEM_SYNC,
    });
  });

  it('matches scheduled jobs by BullMQ job ID and cancels obsolete job IDs safely', async () => {
    const challengeId = 'challenge-active';
    const phaseId = 'phase-active';
    const activeJobId = `${challengeId}|${phaseId}`;
    const obsoleteJobId = 'challenge-obsolete|phase-obsolete';
    const scheduledEndDate = '2026-03-31T09:42:04.567Z';

    schedulerService.getAllScheduledTransitionsWithData.mockReturnValue(
      new Map([
        [
          activeJobId,
          {
            date: scheduledEndDate,
            state: 'END',
          },
        ],
        [
          obsoleteJobId,
          {
            date: '2026-03-30T09:42:04.567Z',
            state: 'END',
          },
        ],
      ]),
    );

    challengeApiService.getAllActiveChallenges.mockImplementation(
      ({ status }: { status?: string }) => {
        if (status === 'ACTIVE') {
          return [
            {
              id: challengeId,
              projectId: 999,
              status: 'ACTIVE',
              phases: [
                {
                  id: phaseId,
                  name: 'Review',
                  isOpen: true,
                  actualEndDate: null,
                  scheduledEndDate,
                },
              ],
            },
          ];
        }

        return [];
      },
    );

    await service.synchronizeChallenges();

    expect(autopilotService.schedulePhaseTransition).not.toHaveBeenCalled();
    expect(autopilotService.reschedulePhaseTransition).not.toHaveBeenCalled();
    expect(autopilotService.cancelPhaseTransition).toHaveBeenCalledTimes(1);
    expect(autopilotService.cancelPhaseTransition).toHaveBeenCalledWith(
      'challenge-obsolete',
      'phase-obsolete',
    );
  });
});
