import type { ConfigService } from '@nestjs/config';
import { PrizeSetTypeEnum } from '@prisma/client';
import type { ChallengeApiService } from '../../challenge/challenge-api.service';
import type { FinanceApiService } from '../../finance/finance-api.service';
import type { MemberApiService } from '../../member-api/member-api.service';
import { AutopilotOperator } from '../interfaces/autopilot.interface';
import type { ReviewApiService } from '../../review/review-api.service';
import type { ReviewService } from '../../review/review.service';
import type { SchedulerService } from './scheduler.service';
import type { PhaseReviewService } from './phase-review.service';
import type { ReviewAssignmentService } from './review-assignment.service';
import type { AutopilotDbLoggerService } from './autopilot-db-logger.service';
import type { First2FinishService } from './first2finish.service';
import { PhaseScheduleManager } from './phase-schedule-manager.service';

describe('PhaseScheduleManager', () => {
  let service: PhaseScheduleManager;
  let schedulerService: {
    setPhaseChainCallback: jest.Mock;
    evaluateManualPhaseCompletion: jest.Mock;
    buildJobId: jest.Mock;
    getScheduledTransition: jest.Mock;
    schedulePhaseTransition: jest.Mock;
    cancelScheduledTransition: jest.Mock;
  };
  let challengeApiService: {
    getChallengeById: jest.Mock;
  };
  let phaseReviewService: {
    handlePhaseOpenedForChallenge: jest.Mock;
  };
  let reviewApiService: {
    createReviewOpportunity: jest.Mock;
    getReviewOpportunitiesByChallengeId: jest.Mock;
  };
  let reviewService: {
    updatePendingReviewScorecards: jest.Mock;
  };
  let dbLogger: {
    logAction: jest.Mock;
  };
  let financeApiService: {
    generateChallengePayments: jest.Mock;
  };
  let memberApiService: {
    syncChallengePoints: jest.Mock;
  };
  let first2FinishService: {
    handleIterativePhaseOpened: jest.Mock;
    handleSubmissionByChallengeId: jest.Mock;
  };

  beforeEach(() => {
    schedulerService = {
      setPhaseChainCallback: jest.fn(),
      evaluateManualPhaseCompletion: jest.fn().mockResolvedValue(undefined),
      buildJobId: jest.fn(
        (challengeId: string, phaseId: string) => `${challengeId}|${phaseId}`,
      ),
      getScheduledTransition: jest.fn().mockReturnValue(undefined),
      schedulePhaseTransition: jest.fn().mockResolvedValue('job-id'),
      cancelScheduledTransition: jest.fn().mockResolvedValue(true),
    };

    challengeApiService = {
      getChallengeById: jest.fn(),
    };

    phaseReviewService = {
      handlePhaseOpenedForChallenge: jest.fn().mockResolvedValue(undefined),
    };

    reviewApiService = {
      createReviewOpportunity: jest.fn().mockResolvedValue({ id: 'opp-1' }),
      getReviewOpportunitiesByChallengeId: jest.fn().mockResolvedValue([]),
    };

    reviewService = {
      updatePendingReviewScorecards: jest.fn().mockResolvedValue(0),
    };

    dbLogger = {
      logAction: jest.fn().mockResolvedValue(undefined),
    };

    financeApiService = {
      generateChallengePayments: jest.fn().mockResolvedValue(true),
    };

    memberApiService = {
      syncChallengePoints: jest.fn().mockResolvedValue(true),
    };

    first2FinishService = {
      handleIterativePhaseOpened: jest.fn().mockResolvedValue(undefined),
      handleSubmissionByChallengeId: jest.fn().mockResolvedValue(undefined),
    };

    service = new PhaseScheduleManager(
      schedulerService as unknown as SchedulerService,
      challengeApiService as unknown as ChallengeApiService,
      phaseReviewService as unknown as PhaseReviewService,
      {} as unknown as ReviewAssignmentService,
      reviewService as unknown as ReviewService,
      reviewApiService as unknown as ReviewApiService,
      {
        get: jest.fn().mockReturnValue(undefined),
      } as unknown as ConfigService,
      dbLogger as unknown as AutopilotDbLoggerService,
      financeApiService as unknown as FinanceApiService,
      first2FinishService as unknown as First2FinishService,
      memberApiService as unknown as MemberApiService,
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

  it('syncs challenge points once when a point-prize challenge transitions to COMPLETED', async () => {
    const message = {
      id: 'challenge-points-1',
      operator: AutopilotOperator.SYSTEM,
      projectId: 1000,
      status: 'COMPLETED',
    };

    challengeApiService.getChallengeById.mockResolvedValue({
      id: message.id,
      name: 'AI Points Challenge',
      status: 'COMPLETED',
      phases: [],
      prizeSets: [
        {
          type: PrizeSetTypeEnum.PLACEMENT,
          prizes: [
            { type: 'POINT', value: 500 },
            { type: 'POINT', value: 250 },
          ],
        },
      ],
      winners: [
        { userId: 101, placement: 1, type: PrizeSetTypeEnum.PLACEMENT },
        { userId: 102, placement: 2, type: PrizeSetTypeEnum.PLACEMENT },
      ],
    });

    await service.handleChallengeUpdate(message);
    await service.handleChallengeUpdate(message);

    expect(memberApiService.syncChallengePoints).toHaveBeenCalledTimes(1);
    expect(memberApiService.syncChallengePoints).toHaveBeenCalledWith(
      message.id,
      'AI Points Challenge',
      [
        { userId: 101, placement: 1, points: 500 },
        { userId: 102, placement: 2, points: 250 },
      ],
    );
  });

  it('delegates manual Marathon Match review phase opens from challenge-api updates', async () => {
    const reviewPhase = {
      id: 'review-phase-instance',
      phaseId: 'review-phase',
      name: 'Review',
      description: null,
      isOpen: true,
      duration: 86400,
      scheduledStartDate: '2026-04-30T00:00:00.000Z',
      scheduledEndDate: '2026-05-01T00:00:00.000Z',
      actualStartDate: '2026-04-30T01:00:00.000Z',
      actualEndDate: null,
      predecessor: 'submission-phase',
      constraints: [],
    };
    const challenge = {
      id: 'challenge-mm',
      status: 'ACTIVE',
      projectId: 1003,
      type: 'Marathon Match',
      phases: [reviewPhase],
      reviewers: [
        {
          id: 'reviewer-config-1',
          isMemberReview: true,
          memberReviewerCount: 1,
          phaseId: reviewPhase.phaseId,
          scorecardId: 'member-review-scorecard',
        },
      ],
      prizeSets: [],
    };

    challengeApiService.getChallengeById.mockResolvedValue(challenge);
    jest
      .spyOn(
        service as unknown as {
          createReviewOpportunitiesForChallenge: () => Promise<void>;
        },
        'createReviewOpportunitiesForChallenge',
      )
      .mockResolvedValue(undefined);

    await service.handleChallengeUpdate({
      id: 'challenge-mm',
      operator: AutopilotOperator.ADMIN,
      projectId: 1003,
      status: 'ACTIVE',
    });

    expect(
      phaseReviewService.handlePhaseOpenedForChallenge,
    ).toHaveBeenCalledWith(challenge, reviewPhase.id);
    expect(reviewService.updatePendingReviewScorecards).not.toHaveBeenCalled();
  });

  it('replays iterative assignment for already-open Iterative Review phases', async () => {
    const iterativePhase = {
      id: 'iterative-phase-instance',
      phaseId: 'iterative-review-phase',
      name: 'Iterative Review',
      description: null,
      isOpen: true,
      duration: 86400,
      scheduledStartDate: '2026-04-30T00:00:00.000Z',
      scheduledEndDate: '2026-05-01T00:00:00.000Z',
      actualStartDate: '2026-04-30T01:00:00.000Z',
      actualEndDate: null,
      predecessor: 'submission-phase',
      constraints: [],
    };
    const challenge = {
      id: 'challenge-topgear',
      status: 'ACTIVE',
      projectId: 1004,
      type: 'Topgear Task',
      phases: [iterativePhase],
      reviewers: [],
      prizeSets: [],
    };

    challengeApiService.getChallengeById.mockResolvedValue(challenge);
    jest
      .spyOn(
        service as unknown as {
          createReviewOpportunitiesForChallenge: () => Promise<void>;
        },
        'createReviewOpportunitiesForChallenge',
      )
      .mockResolvedValue(undefined);

    await service.handleChallengeUpdate({
      id: 'challenge-topgear',
      operator: AutopilotOperator.SYSTEM_RECOVERY,
      projectId: 1004,
      status: 'ACTIVE',
    });

    expect(
      phaseReviewService.handlePhaseOpenedForChallenge.mock.calls,
    ).toContainEqual([challenge, iterativePhase.id]);
    expect(
      first2FinishService.handleIterativePhaseOpened.mock.calls,
    ).toContainEqual([challenge.id, iterativePhase.id]);
    expect(
      first2FinishService.handleSubmissionByChallengeId.mock.calls,
    ).toHaveLength(0);
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

    expect(
      phaseReviewService.handlePhaseOpenedForChallenge,
    ).toHaveBeenCalledTimes(1);
    expect(
      phaseReviewService.handlePhaseOpenedForChallenge,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'challenge-manual-open-dedupe' }),
      'phase-review-1',
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
