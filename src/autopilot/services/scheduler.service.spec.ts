jest.mock('../../kafka/kafka.service', () => ({
  KafkaService: jest.fn().mockImplementation(() => ({
    produce: jest.fn(),
  })),
}));

import { ChallengeStatusEnum } from '@prisma/client';
import { SchedulerService } from './scheduler.service';
import { KafkaService } from '../../kafka/kafka.service';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { PhaseReviewService } from './phase-review.service';
import { ReviewAssignmentService } from './review-assignment.service';
import { ChallengeCompletionService } from './challenge-completion.service';
import { ReviewService } from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';
import { PhaseChangeNotificationService } from './phase-change-notification.service';
import { ConfigService } from '@nestjs/config';
import type {
  IChallenge,
  IPhase,
} from '../../challenge/interfaces/challenge.interface';
import {
  AutopilotOperator,
  PhaseTransitionPayload,
} from '../interfaces/autopilot.interface';
import { FinanceApiService } from '../../finance/finance-api.service';
import { First2FinishService } from './first2finish.service';
import { ITERATIVE_REVIEW_PHASE_NAME } from '../constants/review.constants';

type MockedMethod<T extends (...args: any[]) => any> = jest.Mock<
  ReturnType<T>,
  Parameters<OmitThisParameter<T>>
>;

const createMockMethod = <T extends (...args: any[]) => any>() =>
  jest.fn<ReturnType<T>, Parameters<OmitThisParameter<T>>>();

type ChallengeApiServiceMock = {
  getPhaseDetails: MockedMethod<ChallengeApiService['getPhaseDetails']>;
  advancePhase: MockedMethod<ChallengeApiService['advancePhase']>;
  getChallengePhases: MockedMethod<ChallengeApiService['getChallengePhases']>;
  getChallengeById: MockedMethod<ChallengeApiService['getChallengeById']>;
  cancelChallenge: MockedMethod<ChallengeApiService['cancelChallenge']>;
  createPostMortemPhase: MockedMethod<ChallengeApiService['createPostMortemPhase']>;
};

type ReviewServiceMock = {
  getPendingReviewCount: MockedMethod<ReviewService['getPendingReviewCount']>;
  getPendingAppealCount: MockedMethod<ReviewService['getPendingAppealCount']>;
  getTotalAppealCount: MockedMethod<ReviewService['getTotalAppealCount']>;
  getActiveContestSubmissionIds: MockedMethod<ReviewService['getActiveContestSubmissionIds']>;
  getFailedScreeningSubmissionIds: MockedMethod<ReviewService['getFailedScreeningSubmissionIds']>;
  getPassedScreeningSubmissionIds: MockedMethod<ReviewService['getPassedScreeningSubmissionIds']>;
  getCompletedReviewCountForPhase: MockedMethod<ReviewService['getCompletedReviewCountForPhase']>;
};

type KafkaServiceMock = {
  produce: MockedMethod<KafkaService['produce']>;
};

const createPayload = (
  overrides: Partial<PhaseTransitionPayload> = {},
): PhaseTransitionPayload => ({
  projectId: 123,
  challengeId: 'challenge-1',
  phaseId: 'phase-1',
  phaseTypeName: 'Review',
  state: 'END',
  operator: AutopilotOperator.SYSTEM_PHASE_CHAIN,
  projectStatus: 'ACTIVE',
  ...overrides,
});

const createPhase = (overrides: Partial<IPhase> = {}): IPhase => {
  const now = new Date();
  const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);

  return {
    id: 'phase-1',
    phaseId: 'phase-1',
    name: 'Review',
    description: null,
    isOpen: true,
    duration: 3600,
    scheduledStartDate: now.toISOString(),
    scheduledEndDate: oneHourLater.toISOString(),
    actualStartDate: null,
    actualEndDate: null,
    predecessor: null,
    constraints: [],
    ...overrides,
  };
};

describe('SchedulerService (review phase deferral)', () => {
  let scheduler: SchedulerService;
  let kafkaService: KafkaServiceMock;
  let challengeApiService: ChallengeApiServiceMock;
  let phaseReviewService: jest.Mocked<PhaseReviewService>;
  let reviewAssignmentService: jest.Mocked<ReviewAssignmentService>;
  let challengeCompletionService: jest.Mocked<ChallengeCompletionService>;
  let financeApiService: jest.Mocked<FinanceApiService>;
  let reviewService: ReviewServiceMock;
  let resourcesService: jest.Mocked<ResourcesService>;
  let phaseChangeNotificationService: jest.Mocked<PhaseChangeNotificationService>;
  let configService: jest.Mocked<ConfigService>;
  let first2FinishService: jest.Mocked<First2FinishService>;

  beforeEach(() => {
    kafkaService = {
      produce: createMockMethod<KafkaService['produce']>(),
    };

    challengeApiService = {
      getPhaseDetails:
        createMockMethod<ChallengeApiService['getPhaseDetails']>(),
      advancePhase: createMockMethod<ChallengeApiService['advancePhase']>(),
      getChallengePhases:
        createMockMethod<ChallengeApiService['getChallengePhases']>(),
      getChallengeById:
        createMockMethod<ChallengeApiService['getChallengeById']>(),
      cancelChallenge:
        createMockMethod<ChallengeApiService['cancelChallenge']>(),
      createPostMortemPhase:
        createMockMethod<ChallengeApiService['createPostMortemPhase']>(),
    };
    challengeApiService.cancelChallenge.mockResolvedValue(undefined);
    challengeApiService.getChallengeById.mockResolvedValue({
      id: 'challenge-1',
      phases: [
        createPhase({
          id: 'phase-1',
          phaseId: 'phase-1',
          name: 'Review',
        }),
      ],
      reviewers: [
        {
          id: 'reviewer-config-1',
          scorecardId: 'scorecard-1',
          isMemberReview: true,
          memberReviewerCount: 1,
          phaseId: 'phase-1',
          fixedAmount: null,
          baseCoefficient: null,
          incrementalCoefficient: null,
          type: null,
          aiWorkflowId: null,
          shouldOpenOpportunity: false,
        },
      ],
      legacy: {},
    } as unknown as IChallenge);
    challengeApiService.createPostMortemPhase.mockResolvedValue(
      createPhase({ name: 'Post-Mortem' }),
    );

    phaseReviewService = {
      handlePhaseOpened: jest.fn(),
    } as unknown as jest.Mocked<PhaseReviewService>;

    reviewAssignmentService = {
      ensureAssignmentsOrSchedule: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<ReviewAssignmentService>;

    challengeCompletionService = {
      finalizeChallenge: jest.fn().mockResolvedValue(true),
      assignCheckpointWinners: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ChallengeCompletionService>;

    financeApiService = {
      generateChallengePayments: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<FinanceApiService>;

    reviewService = {
      getPendingReviewCount:
        createMockMethod<ReviewService['getPendingReviewCount']>(),
      getPendingAppealCount:
        createMockMethod<ReviewService['getPendingAppealCount']>(),
      getTotalAppealCount:
        createMockMethod<ReviewService['getTotalAppealCount']>(),
      getActiveContestSubmissionIds:
        createMockMethod<ReviewService['getActiveContestSubmissionIds']>(),
      getFailedScreeningSubmissionIds:
        createMockMethod<ReviewService['getFailedScreeningSubmissionIds']>(),
      getPassedScreeningSubmissionIds:
        createMockMethod<ReviewService['getPassedScreeningSubmissionIds']>(),
      getCompletedReviewCountForPhase:
        createMockMethod<ReviewService['getCompletedReviewCountForPhase']>(),
    };
    reviewService.getTotalAppealCount.mockResolvedValue(1);
    reviewService.getPendingAppealCount.mockResolvedValue(0);
    reviewService.getPendingReviewCount.mockResolvedValue(0);
    reviewService.getCompletedReviewCountForPhase.mockResolvedValue(1);
    reviewService.getActiveContestSubmissionIds.mockResolvedValue([]);
    reviewService.getFailedScreeningSubmissionIds.mockResolvedValue(
      new Set(),
    );
    reviewService.getPassedScreeningSubmissionIds.mockResolvedValue(
      new Set(),
    );

    resourcesService = {
      hasSubmitterResource: jest.fn().mockResolvedValue(true),
      getResourcesByRoleNames: jest.fn().mockResolvedValue([]),
      getReviewerResources: jest.fn().mockResolvedValue([{} as any]),
      ensureResourcesForMembers: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<ResourcesService>;

    phaseChangeNotificationService = {
      sendPhaseChangeNotification: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<PhaseChangeNotificationService>;

    configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<ConfigService>;

    first2FinishService = {
      handleIterativePhaseClosed: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<First2FinishService>;

    scheduler = new SchedulerService(
      kafkaService as unknown as KafkaService,
      challengeApiService as unknown as ChallengeApiService,
      phaseReviewService,
      reviewAssignmentService,
      challengeCompletionService,
      financeApiService,
      reviewService as unknown as ReviewService,
      resourcesService,
      phaseChangeNotificationService,
      configService,
      first2FinishService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('defers closing review phases when pending reviews exist', async () => {
    const payload = createPayload();
    const phaseDetails = createPhase({
      id: payload.phaseId,
      phaseId: payload.phaseId,
      name: 'Review',
      isOpen: true,
    });

    challengeApiService.getPhaseDetails.mockResolvedValue(phaseDetails);
    reviewService.getPendingReviewCount.mockResolvedValue(2);

    const scheduleSpy = jest
      .spyOn(scheduler, 'schedulePhaseTransition')
      .mockResolvedValue('rescheduled');

    await scheduler.advancePhase(payload);

    expect(challengeApiService.advancePhase).not.toHaveBeenCalled();
    expect(reviewService.getPendingReviewCount).toHaveBeenCalledWith(
      payload.phaseId,
      payload.challengeId,
    );
    expect(scheduleSpy).toHaveBeenCalledTimes(1);

    const [rescheduledPayload] = scheduleSpy.mock.calls[0];
    expect(rescheduledPayload.state).toBe('END');
    expect(rescheduledPayload.phaseId).toBe(payload.phaseId);
    expect(rescheduledPayload.challengeId).toBe(payload.challengeId);
    expect(rescheduledPayload.date).toBeDefined();
    expect(
      new Date(rescheduledPayload.date as string).getTime(),
    ).toBeGreaterThan(Date.now());
  });

  it('defers closing review phases when no reviewers are defined', async () => {
    const payload = createPayload();
    const phaseDetails = createPhase({
      id: payload.phaseId,
      phaseId: payload.phaseId,
      name: 'Review',
      isOpen: true,
    });

    challengeApiService.getPhaseDetails.mockResolvedValue(phaseDetails);
    challengeApiService.getChallengeById.mockResolvedValue({
      id: payload.challengeId,
      phases: [phaseDetails],
      reviewers: [],
      legacy: {},
    } as unknown as IChallenge);

    const scheduleSpy = jest
      .spyOn(scheduler, 'schedulePhaseTransition')
      .mockResolvedValue('rescheduled');

    await scheduler.advancePhase(payload);

    expect(challengeApiService.advancePhase).not.toHaveBeenCalled();
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });

  it('defers closing review phases when no reviews are completed', async () => {
    const payload = createPayload();
    const phaseDetails = createPhase({
      id: payload.phaseId,
      phaseId: payload.phaseId,
      name: 'Review',
      isOpen: true,
    });

    challengeApiService.getPhaseDetails.mockResolvedValue(phaseDetails);
    reviewService.getCompletedReviewCountForPhase.mockResolvedValue(0);

    const scheduleSpy = jest
      .spyOn(scheduler, 'schedulePhaseTransition')
      .mockResolvedValue('rescheduled');

    await scheduler.advancePhase(payload);

    expect(challengeApiService.advancePhase).not.toHaveBeenCalled();
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });

  it('opens appeals immediately after closing review even when successors are not returned', async () => {
    const payload = createPayload();
    const phaseDetails = createPhase({
      id: payload.phaseId,
      phaseId: 'template-review',
      name: 'Review',
      isOpen: true,
    });

    const appealsPhase = createPhase({
      id: 'phase-appeals',
      phaseId: 'template-appeals',
      name: 'Appeals',
      isOpen: false,
      actualStartDate: null,
      actualEndDate: null,
      scheduledStartDate: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      scheduledEndDate: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    });

    challengeApiService.getPhaseDetails.mockResolvedValue(phaseDetails);
    challengeApiService.advancePhase.mockResolvedValue({
      success: true,
      message: 'closed review',
      updatedPhases: [phaseDetails, appealsPhase],
    });

    const callback = jest.fn();
    scheduler.setPhaseChainCallback(callback);

    await scheduler.advancePhase(payload);

    expect(callback).toHaveBeenCalledWith(
      payload.challengeId,
      payload.projectId,
      payload.projectStatus,
      [expect.objectContaining({ id: appealsPhase.id })],
    );
  });

  it('opens appeals directly after closing review when phase chain callback is missing', async () => {
    const payload = createPayload();
    const reviewPhase = createPhase({
      id: payload.phaseId,
      phaseId: 'template-review',
      name: 'Review',
      isOpen: true,
    });
    const appealsPhase = createPhase({
      id: 'phase-appeals',
      phaseId: 'template-appeals',
      name: 'Appeals',
      isOpen: false,
      actualStartDate: null,
      actualEndDate: null,
    });

    challengeApiService.getPhaseDetails.mockImplementation(
      async (_challengeId, phaseId) => {
        if (phaseId === reviewPhase.id) {
          return reviewPhase;
        }
        if (phaseId === appealsPhase.id) {
          return appealsPhase;
        }
        return null;
      },
    );

    challengeApiService.advancePhase.mockImplementation(
      async (_challengeId, phaseId, operation) => {
        if (phaseId === reviewPhase.id && operation === 'close') {
          return {
            success: true,
            message: 'closed review',
            updatedPhases: [reviewPhase, appealsPhase],
            next: {
              operation: 'open',
              phases: [appealsPhase],
            },
          };
        }

        if (phaseId === appealsPhase.id && operation === 'open') {
          return {
            success: true,
            message: 'opened appeals',
            updatedPhases: [appealsPhase],
          };
        }

        return {
          success: true,
          message: 'ok',
          updatedPhases: [],
        };
      },
    );

    await scheduler.advancePhase(payload);

    expect(challengeApiService.advancePhase).toHaveBeenCalledWith(
      payload.challengeId,
      payload.phaseId,
      'close',
    );
    expect(challengeApiService.advancePhase).toHaveBeenCalledWith(
      payload.challengeId,
      appealsPhase.id,
      'open',
    );
  });

  it('closes review phases when no pending reviews remain', async () => {
    const payload = createPayload();
    const phaseDetails = createPhase({
      id: payload.phaseId,
      phaseId: payload.phaseId,
      name: 'Review',
      isOpen: true,
    });

    challengeApiService.getPhaseDetails.mockResolvedValue(phaseDetails);
    reviewService.getPendingReviewCount.mockResolvedValue(0);

    const advancePhaseResponse: Awaited<
      ReturnType<ChallengeApiService['advancePhase']>
    > = {
      success: true,
      message: 'closed',
      updatedPhases: [
        createPhase({
          id: payload.phaseId,
          phaseId: payload.phaseId,
          isOpen: false,
          actualEndDate: new Date().toISOString(),
        }),
      ],
    };

    challengeApiService.advancePhase.mockResolvedValue(advancePhaseResponse);

    await scheduler.advancePhase(payload);

    expect(reviewService.getPendingReviewCount).toHaveBeenCalled();
    expect(challengeApiService.advancePhase).toHaveBeenCalledWith(
      payload.challengeId,
      payload.phaseId,
      'close',
    );
  });

  it('refreshes submissions when iterative review closes', async () => {
    const payload = createPayload({
      phaseTypeName: ITERATIVE_REVIEW_PHASE_NAME,
    });
    const phaseDetails = createPhase({
      id: payload.phaseId,
      phaseId: payload.phaseId,
      name: ITERATIVE_REVIEW_PHASE_NAME,
      isOpen: true,
    });

    challengeApiService.getPhaseDetails.mockResolvedValue(phaseDetails);
    reviewService.getPendingReviewCount.mockResolvedValue(0);
    challengeApiService.advancePhase.mockResolvedValue({
      success: true,
      message: 'closed iterative review',
      updatedPhases: [],
    });

    await scheduler.advancePhase(payload);

    expect(
      first2FinishService.handleIterativePhaseClosed,
    ).toHaveBeenCalledWith(payload.challengeId);
  });

  it('skips iterative submission refresh when instructed', async () => {
    const payload = createPayload({
      phaseTypeName: ITERATIVE_REVIEW_PHASE_NAME,
      skipIterativePhaseRefresh: true,
    });
    const phaseDetails = createPhase({
      id: payload.phaseId,
      phaseId: payload.phaseId,
      name: ITERATIVE_REVIEW_PHASE_NAME,
      isOpen: true,
    });

    challengeApiService.getPhaseDetails.mockResolvedValue(phaseDetails);
    reviewService.getPendingReviewCount.mockResolvedValue(0);
    challengeApiService.advancePhase.mockResolvedValue({
      success: true,
      message: 'closed iterative review',
      updatedPhases: [],
    });

    await scheduler.advancePhase(payload);

    expect(first2FinishService.handleIterativePhaseClosed).not.toHaveBeenCalled();
  });

  it('assigns checkpoint winners after closing checkpoint review', async () => {
    const payload = createPayload({
      phaseId: 'checkpoint-phase',
      phaseTypeName: 'Checkpoint Review',
    });
    const phaseDetails = createPhase({
      id: payload.phaseId,
      phaseId: payload.phaseId,
      name: 'Checkpoint Review',
      isOpen: true,
    });

    challengeApiService.getPhaseDetails.mockResolvedValue(phaseDetails);
    reviewService.getPendingReviewCount.mockResolvedValue(0);

    const advancePhaseResponse: Awaited<
      ReturnType<ChallengeApiService['advancePhase']>
    > = {
      success: true,
      message: 'closed checkpoint review',
      updatedPhases: [
        createPhase({
          id: payload.phaseId,
          phaseId: payload.phaseId,
          name: 'Checkpoint Review',
          isOpen: false,
          actualEndDate: new Date().toISOString(),
        }),
        createPhase({
          id: 'next-phase',
          phaseId: 'next-phase',
          name: 'Final Review',
          isOpen: true,
        }),
      ],
    };

    challengeApiService.advancePhase.mockResolvedValue(advancePhaseResponse);

    await scheduler.advancePhase(payload);

    expect(
      challengeCompletionService.assignCheckpointWinners,
    ).toHaveBeenCalledWith(payload.challengeId, payload.phaseId);
  });

  it('defers closing appeals phases when pending appeal responses exist', async () => {
    const payload = createPayload({
      phaseId: 'appeals-phase',
      phaseTypeName: 'Appeals Response',
    });
    const phaseDetails = createPhase({
      id: payload.phaseId,
      phaseId: payload.phaseId,
      name: 'Appeals Response',
      isOpen: true,
    });

    challengeApiService.getPhaseDetails.mockResolvedValue(phaseDetails);
    reviewService.getPendingAppealCount.mockResolvedValue(2);

    const scheduleSpy = jest
      .spyOn(scheduler, 'schedulePhaseTransition')
      .mockResolvedValue('appeals-rescheduled');

    await scheduler.advancePhase(payload);

    expect(reviewService.getPendingAppealCount).toHaveBeenCalledWith(
      payload.challengeId,
    );
    expect(reviewService.getPendingReviewCount).not.toHaveBeenCalled();
    expect(challengeApiService.advancePhase).not.toHaveBeenCalled();
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });

  it('closes appeals phase without pending appeal check', async () => {
    const payload = createPayload({
      phaseId: 'appeals-phase',
      phaseTypeName: 'Appeals',
    });
    const phaseDetails = createPhase({
      id: payload.phaseId,
      phaseId: payload.phaseId,
      name: 'Appeals',
      isOpen: true,
    });

    challengeApiService.getPhaseDetails.mockResolvedValue(phaseDetails);
    reviewService.getPendingAppealCount.mockResolvedValue(0);

    const advancePhaseResponse: Awaited<
      ReturnType<ChallengeApiService['advancePhase']>
    > = {
      success: true,
      message: 'closed appeals',
      updatedPhases: [
        createPhase({
          id: payload.phaseId,
          phaseId: payload.phaseId,
          name: 'Appeals',
          isOpen: false,
          actualEndDate: new Date().toISOString(),
        }),
      ],
    };

    challengeApiService.advancePhase.mockResolvedValue(advancePhaseResponse);

    await scheduler.advancePhase(payload);

    expect(reviewService.getPendingAppealCount).not.toHaveBeenCalled();
    expect(challengeApiService.advancePhase).toHaveBeenCalledWith(
      payload.challengeId,
      payload.phaseId,
      'close',
    );
  });

  it('closes appeals response phase when all responses are in', async () => {
    const payload = createPayload({
      phaseId: 'appeals-response-phase',
      phaseTypeName: 'Appeals Response',
    });
    const phaseDetails = createPhase({
      id: payload.phaseId,
      phaseId: payload.phaseId,
      name: 'Appeals Response',
      isOpen: true,
    });

    challengeApiService.getPhaseDetails.mockResolvedValue(phaseDetails);
    reviewService.getPendingAppealCount.mockResolvedValue(0);

    const advancePhaseResponse: Awaited<
      ReturnType<ChallengeApiService['advancePhase']>
    > = {
      success: true,
      message: 'closed appeals response',
      updatedPhases: [
        createPhase({
          id: payload.phaseId,
          phaseId: payload.phaseId,
          name: 'Appeals Response',
          isOpen: false,
          actualEndDate: new Date().toISOString(),
        }),
      ],
    };

    challengeApiService.advancePhase.mockResolvedValue(advancePhaseResponse);

    await scheduler.advancePhase(payload);

    expect(reviewService.getPendingAppealCount).toHaveBeenCalledWith(
      payload.challengeId,
    );
    expect(challengeApiService.advancePhase).toHaveBeenCalledWith(
      payload.challengeId,
      payload.phaseId,
      'close',
    );
  });

  it('auto-closes appeals response phase immediately when no appeals exist on open', async () => {
    const payload = createPayload({
      state: 'START',
      phaseId: 'appeals-response-phase',
      phaseTypeName: 'Appeals Response',
    });

    const closedPhaseDetails = createPhase({
      id: payload.phaseId,
      phaseId: payload.phaseId,
      name: 'Appeals Response',
      isOpen: false,
    });
    const openPhaseDetails = createPhase({
      id: payload.phaseId,
      phaseId: payload.phaseId,
      name: 'Appeals Response',
      isOpen: true,
    });

    challengeApiService.getPhaseDetails
      .mockResolvedValueOnce(closedPhaseDetails)
      .mockResolvedValueOnce(openPhaseDetails);

    reviewService.getTotalAppealCount.mockResolvedValue(0);
    reviewService.getPendingAppealCount.mockResolvedValue(0);

    const openResponse: Awaited<
      ReturnType<ChallengeApiService['advancePhase']>
    > = {
      success: true,
      message: 'opened appeals response',
      updatedPhases: [
        createPhase({
          id: payload.phaseId,
          phaseId: payload.phaseId,
          name: 'Appeals Response',
          isOpen: true,
          actualStartDate: new Date().toISOString(),
        }),
      ],
    };

    const closeResponse: Awaited<
      ReturnType<ChallengeApiService['advancePhase']>
    > = {
      success: true,
      message: 'closed appeals response',
      updatedPhases: [
        createPhase({
          id: payload.phaseId,
          phaseId: payload.phaseId,
          name: 'Appeals Response',
          isOpen: false,
          actualEndDate: new Date().toISOString(),
        }),
      ],
    };

    challengeApiService.advancePhase
      .mockResolvedValueOnce(openResponse)
      .mockResolvedValueOnce(closeResponse);

    await scheduler.advancePhase(payload);

    expect(challengeApiService.advancePhase).toHaveBeenNthCalledWith(
      1,
      payload.challengeId,
      payload.phaseId,
      'open',
    );
    expect(reviewService.getTotalAppealCount).toHaveBeenCalledWith(
      payload.challengeId,
    );
    expect(challengeApiService.advancePhase).toHaveBeenNthCalledWith(
      2,
      payload.challengeId,
      payload.phaseId,
      'close',
    );
    expect(reviewService.getPendingAppealCount).toHaveBeenCalledWith(
      payload.challengeId,
    );
  });

  it('cancels challenge as failed screening when all active submissions fail screening', async () => {
    const payload = createPayload({
      phaseId: 'screening-phase',
      phaseTypeName: 'Screening',
    });

    const phaseDetails = createPhase({
      id: payload.phaseId,
      phaseId: payload.phaseId,
      name: 'Screening',
      isOpen: true,
    });

    challengeApiService.getPhaseDetails.mockResolvedValue(phaseDetails);
    reviewService.getPendingReviewCount.mockResolvedValue(0);
    reviewService.getActiveContestSubmissionIds.mockResolvedValue([
      'submission-1',
      'submission-2',
    ]);
    reviewService.getFailedScreeningSubmissionIds.mockResolvedValue(
      new Set(['submission-1', 'submission-2']),
    );
    reviewService.getPassedScreeningSubmissionIds.mockResolvedValue(
      new Set(),
    );

    const challenge = {
      id: payload.challengeId,
      phases: [],
      reviewers: [],
      legacy: { screeningScorecardId: 'screening-scorecard' },
    } as unknown as IChallenge;
    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    const postMortemPhase = createPhase({
      id: 'post-mortem-phase',
      phaseId: 'post-mortem-template',
      name: 'Post-Mortem',
      isOpen: true,
    });
    challengeApiService.createPostMortemPhase.mockResolvedValue(
      postMortemPhase,
    );

    const advancePhaseResponse: Awaited<
      ReturnType<ChallengeApiService['advancePhase']>
    > = {
      success: true,
      message: 'closed screening',
      updatedPhases: [
        createPhase({
          id: payload.phaseId,
          phaseId: payload.phaseId,
          name: 'Screening',
          isOpen: false,
          actualEndDate: new Date().toISOString(),
        }),
      ],
    };
    challengeApiService.advancePhase.mockResolvedValue(advancePhaseResponse);

    const coverageSpy = jest
      .spyOn(scheduler as any, 'verifyReviewerCoverage')
      .mockResolvedValue({ satisfied: true, expected: 0, actual: 0 });
    const scheduleSpy = jest
      .spyOn(scheduler, 'schedulePhaseTransition')
      .mockResolvedValue('post-mortem-scheduled');

    await scheduler.advancePhase(payload);

    expect(challengeApiService.cancelChallenge).toHaveBeenCalledWith(
      payload.challengeId,
      ChallengeStatusEnum.CANCELLED_FAILED_SCREENING,
    );
    expect(reviewService.getFailedScreeningSubmissionIds).toHaveBeenCalledWith(
      payload.challengeId,
      ['screening-scorecard'],
    );
    expect(
      financeApiService.generateChallengePayments,
    ).toHaveBeenCalledWith(payload.challengeId);
    expect(challengeApiService.createPostMortemPhase).toHaveBeenCalledWith(
      payload.challengeId,
      payload.phaseId,
      expect.any(Number),
    );
    expect(scheduleSpy).toHaveBeenCalled();

    coverageSpy.mockRestore();
    scheduleSpy.mockRestore();
  });

  describe('handleSubmissionPhaseClosed', () => {
    it('cancels challenge as zero submissions while keeping post-mortem open', async () => {
      const payload = createPayload({
        phaseId: 'submission-phase',
        phaseTypeName: 'Submission',
      });

      const postMortemPhase = createPhase({
        id: 'post-mortem-phase',
        name: 'Post-Mortem',
      });

      challengeApiService.createPostMortemPhase.mockResolvedValue(
        postMortemPhase,
      );

      const pendingReviewSpy = jest
        .spyOn(scheduler as any, 'createPostMortemPendingReviews')
        .mockResolvedValue(undefined);
      const scheduleSpy = jest
        .spyOn(scheduler, 'schedulePhaseTransition')
        .mockResolvedValue('scheduled-job');

      const result = await (scheduler as any).handleSubmissionPhaseClosed(
        payload,
      );

      expect(result).toBe(true);
      expect(resourcesService.hasSubmitterResource).toHaveBeenCalledWith(
        payload.challengeId,
        expect.any(Array),
      );
      expect(challengeApiService.cancelChallenge).toHaveBeenCalledWith(
        payload.challengeId,
        ChallengeStatusEnum.CANCELLED_ZERO_SUBMISSIONS,
      );
      expect(scheduleSpy).toHaveBeenCalled();

      pendingReviewSpy.mockRestore();
      scheduleSpy.mockRestore();
    });

    it('cancels challenge as zero registrations when no submitters exist', async () => {
      resourcesService.hasSubmitterResource.mockResolvedValue(false);

      const payload = createPayload({
        phaseId: 'submission-phase',
        phaseTypeName: 'Submission',
      });

      const postMortemPhase = createPhase({
        id: 'post-mortem-phase',
        name: 'Post-Mortem',
      });

      challengeApiService.createPostMortemPhase.mockResolvedValue(
        postMortemPhase,
      );

      const pendingReviewSpy = jest
        .spyOn(scheduler as any, 'createPostMortemPendingReviews')
        .mockResolvedValue(undefined);
      const scheduleSpy = jest
        .spyOn(scheduler, 'schedulePhaseTransition')
        .mockResolvedValue('scheduled-job');

      await (scheduler as any).handleSubmissionPhaseClosed(payload);

      expect(challengeApiService.cancelChallenge).toHaveBeenCalledWith(
        payload.challengeId,
        ChallengeStatusEnum.CANCELLED_ZERO_REGISTRATIONS,
      );

      pendingReviewSpy.mockRestore();
      scheduleSpy.mockRestore();
    });
  });

  describe('handlePostMortemPhaseClosed', () => {
    it('skips cancelling when already marked with the target status', async () => {
      const payload = createPayload({
        phaseId: 'post-mortem-phase',
        phaseTypeName: 'Post-Mortem',
      });

      challengeApiService.getChallengeById.mockResolvedValueOnce({
        id: payload.challengeId,
        phases: [],
        reviewers: [],
        legacy: {},
        status: ChallengeStatusEnum.CANCELLED_ZERO_SUBMISSIONS,
      } as unknown as IChallenge);

      await (scheduler as any).handlePostMortemPhaseClosed(payload);

      expect(challengeApiService.cancelChallenge).not.toHaveBeenCalled();
    });
  });
});
