import { AutopilotOperator } from '../interfaces/autopilot.interface';
import { PhaseScheduleManager } from './phase-schedule-manager.service';

describe('PhaseScheduleManager', () => {
  let service: PhaseScheduleManager;
  let schedulerService: {
    setPhaseChainCallback: jest.Mock;
    evaluateManualPhaseCompletion: jest.Mock;
  };
  let phaseReviewService: {
    handlePhaseOpenedForChallenge: jest.Mock;
  };
  let challengeApiService: {
    getChallengeById: jest.Mock;
  };
  let financeApiService: {
    generateChallengePayments: jest.Mock;
  };

  beforeEach(() => {
    schedulerService = {
      setPhaseChainCallback: jest.fn(),
      evaluateManualPhaseCompletion: jest.fn().mockResolvedValue(undefined),
    };

    phaseReviewService = {
      handlePhaseOpenedForChallenge: jest.fn().mockResolvedValue(undefined),
    };

    challengeApiService = {
      getChallengeById: jest.fn(),
    };

    financeApiService = {
      generateChallengePayments: jest.fn().mockResolvedValue(true),
    };

    service = new PhaseScheduleManager(
      schedulerService as any,
      challengeApiService as any,
      phaseReviewService as any,
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

  it('processes unchanged open review phases only once during manual phase detection', async () => {
    const reviewPhase = {
      id: 'phase-review-1',
      phaseId: 'template-review-1',
      name: 'Review',
      isOpen: true,
      actualStartDate: '2026-03-26T10:17:54.388Z',
      scheduledStartDate: '2026-03-26T10:17:54.388Z',
      actualEndDate: null,
      scheduledEndDate: '2026-03-28T10:17:54.388Z',
    };

    challengeApiService.getChallengeById.mockResolvedValue({
      id: 'challenge-manual-open-dedupe',
      status: 'ACTIVE',
      phases: [reviewPhase],
      reviewers: [],
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
      .mockResolvedValue(0);

    jest
      .spyOn(
        service as unknown as {
          scheduleRelevantPhases: () => Promise<void>;
        },
        'scheduleRelevantPhases',
      )
      .mockResolvedValue(undefined);

    jest
      .spyOn(
        service as unknown as {
          resolveScorecardIdForOpenPhase: () => string | null;
        },
        'resolveScorecardIdForOpenPhase',
      )
      .mockReturnValue(null);

    const updateMessage = {
      id: 'challenge-manual-open-dedupe',
      operator: AutopilotOperator.SYSTEM,
      projectId: 1003,
      status: 'ACTIVE',
    };

    await service.handleChallengeUpdate(updateMessage);
    await service.handleChallengeUpdate(updateMessage);

    expect(phaseReviewService.handlePhaseOpenedForChallenge).toHaveBeenCalledTimes(
      1,
    );
    expect(phaseReviewService.handlePhaseOpenedForChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'challenge-manual-open-dedupe' }),
      'phase-review-1',
    );
  });
});
