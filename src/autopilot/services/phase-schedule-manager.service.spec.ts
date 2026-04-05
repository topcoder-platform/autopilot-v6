import type { ConfigService } from '@nestjs/config';
import type { ChallengeApiService } from '../../challenge/challenge-api.service';
import type { FinanceApiService } from '../../finance/finance-api.service';
import { AutopilotOperator } from '../interfaces/autopilot.interface';
import type { ReviewApiService } from '../../review/review-api.service';
import type { ReviewService } from '../../review/review.service';
import type { SchedulerService } from './scheduler.service';
import type { PhaseReviewService } from './phase-review.service';
import type { ReviewAssignmentService } from './review-assignment.service';
import type { AutopilotDbLoggerService } from './autopilot-db-logger.service';
import { PhaseScheduleManager } from './phase-schedule-manager.service';

describe('PhaseScheduleManager', () => {
  let service: PhaseScheduleManager;
  let challengeApiService: {
    getChallengeById: jest.Mock;
  };
  let reviewApiService: {
    createReviewOpportunity: jest.Mock;
    getReviewOpportunitiesByChallengeId: jest.Mock;
  };
  let dbLogger: {
    logAction: jest.Mock;
  };
  let financeApiService: {
    generateChallengePayments: jest.Mock;
  };

  beforeEach(() => {
    challengeApiService = {
      getChallengeById: jest.fn(),
    };

    reviewApiService = {
      createReviewOpportunity: jest.fn().mockResolvedValue({ id: 'opp-1' }),
      getReviewOpportunitiesByChallengeId: jest.fn().mockResolvedValue([]),
    };

    dbLogger = {
      logAction: jest.fn().mockResolvedValue(undefined),
    };

    financeApiService = {
      generateChallengePayments: jest.fn().mockResolvedValue(true),
    };

    service = new PhaseScheduleManager(
      {
        setPhaseChainCallback: jest.fn(),
      } as unknown as SchedulerService,
      challengeApiService as unknown as ChallengeApiService,
      {} as unknown as PhaseReviewService,
      {} as unknown as ReviewAssignmentService,
      {} as unknown as ReviewService,
      reviewApiService as unknown as ReviewApiService,
      {
        get: jest.fn().mockReturnValue(undefined),
      } as unknown as ConfigService,
      dbLogger as unknown as AutopilotDbLoggerService,
      financeApiService as unknown as FinanceApiService,
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

  it('infers iterative review opportunities from the reviewer phase when reviewer type is missing', async () => {
    await (
      service as unknown as {
        createReviewOpportunitiesForChallenge: (
          challenge: unknown,
        ) => Promise<void>;
      }
    ).createReviewOpportunitiesForChallenge({
      id: 'challenge-iterative',
      status: 'ACTIVE',
      phases: [
        {
          id: 'phase-1',
          phaseId: 'iterative-review-phase',
          name: 'Iterative Review',
          duration: 86400,
          scheduledStartDate: '2026-04-02T00:00:00.000Z',
          actualStartDate: null,
        },
      ],
      prizeSets: [],
      reviewers: [
        {
          id: 'reviewer-1',
          isMemberReview: true,
          memberReviewerCount: 1,
          phaseId: 'iterative-review-phase',
          fixedAmount: 25,
          baseCoefficient: null,
          incrementalCoefficient: null,
          type: null,
          shouldOpenOpportunity: true,
        },
      ],
    });

    expect(reviewApiService.createReviewOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: 'challenge-iterative',
        type: 'ITERATIVE_REVIEW',
      }),
    );
  });
});
