import { AutopilotOperator } from '../interfaces/autopilot.interface';
import { PhaseScheduleManager } from './phase-schedule-manager.service';

describe('PhaseScheduleManager', () => {
  let service: PhaseScheduleManager;
  let challengeApiService: {
    getChallengeById: jest.Mock;
  };
  let financeApiService: {
    generateChallengePayments: jest.Mock;
  };

  beforeEach(() => {
    challengeApiService = {
      getChallengeById: jest.fn(),
    };

    financeApiService = {
      generateChallengePayments: jest.fn().mockResolvedValue(true),
    };

    service = new PhaseScheduleManager(
      {
        setPhaseChainCallback: jest.fn(),
      } as any,
      challengeApiService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        get: jest.fn().mockReturnValue(undefined),
      } as any,
      {
        logAction: jest.fn(),
      } as any,
      financeApiService as any,
    );
  });

  it('triggers finance generation once when challenge transitions to COMPLETED', async () => {
    challengeApiService.getChallengeById.mockResolvedValue({
      id: 'challenge-1',
      status: 'COMPLETED',
      phases: [],
    });

    const message = {
      id: 'challenge-1',
      operator: AutopilotOperator.SYSTEM,
      projectId: 1000,
      status: 'COMPLETED',
    };

    await service.handleChallengeUpdate(message);
    await service.handleChallengeUpdate(message);

    expect(financeApiService.generateChallengePayments).toHaveBeenCalledTimes(
      1,
    );
    expect(financeApiService.generateChallengePayments).toHaveBeenCalledWith(
      'challenge-1',
    );
  });

  it('does not trigger finance generation for non-payable non-active statuses', async () => {
    challengeApiService.getChallengeById.mockResolvedValue({
      id: 'challenge-2',
      status: 'CANCELLED_ZERO_SUBMISSIONS',
      phases: [],
    });

    await service.handleChallengeUpdate({
      id: 'challenge-2',
      operator: AutopilotOperator.SYSTEM,
      projectId: 1001,
      status: 'CANCELLED_ZERO_SUBMISSIONS',
    });

    expect(financeApiService.generateChallengePayments).not.toHaveBeenCalled();
  });

  it('triggers finance generation when an ACTIVE challenge becomes COMPLETED after immediate phase closures', async () => {
    challengeApiService.getChallengeById
      .mockResolvedValueOnce({
        id: 'challenge-3',
        status: 'ACTIVE',
        phases: [],
      })
      .mockResolvedValueOnce({
        id: 'challenge-3',
        status: 'COMPLETED',
        phases: [],
      });

    jest
      .spyOn(
        service as unknown as {
          createReviewOpportunitiesForChallenge: () => Promise<void>;
        },
        'createReviewOpportunitiesForChallenge',
      )
      .mockResolvedValue(undefined);

    jest
      .spyOn(
        service as unknown as {
          processPastDueOpenPhases: () => Promise<number>;
        },
        'processPastDueOpenPhases',
      )
      .mockResolvedValue(1);

    await service.handleChallengeUpdate({
      id: 'challenge-3',
      operator: AutopilotOperator.SYSTEM,
      projectId: 1002,
      status: 'ACTIVE',
    });

    expect(financeApiService.generateChallengePayments).toHaveBeenCalledTimes(
      1,
    );
    expect(financeApiService.generateChallengePayments).toHaveBeenCalledWith(
      'challenge-3',
    );
  });
});
