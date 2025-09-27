jest.mock('../../kafka/kafka.service', () => ({
  KafkaService: jest.fn().mockImplementation(() => ({})),
}));

import { AutopilotService } from './autopilot.service';
import { SubmissionAggregatePayload } from '../interfaces/autopilot.interface';
import type { PhaseScheduleManager } from './phase-schedule-manager.service';
import type { ResourceEventHandler } from './resource-event-handler.service';
import type { First2FinishService } from './first2finish.service';
import type { SchedulerService } from './scheduler.service';
import type { ChallengeApiService } from '../../challenge/challenge-api.service';
import type { ReviewService } from '../../review/review.service';
import type { ConfigService } from '@nestjs/config';

type MockedMethod<T extends (...args: any[]) => any> = jest.Mock<
  ReturnType<T>,
  Parameters<OmitThisParameter<T>>
>;

const createMockMethod = <T extends (...args: any[]) => any>() =>
  jest.fn<ReturnType<T>, Parameters<OmitThisParameter<T>>>();

type First2FinishServiceMock = {
  handleSubmissionByChallengeId: MockedMethod<
    First2FinishService['handleSubmissionByChallengeId']
  >;
  handleIterativeReviewerAdded: MockedMethod<
    First2FinishService['handleIterativeReviewerAdded']
  >;
  handleIterativeReviewCompletion: MockedMethod<
    First2FinishService['handleIterativeReviewCompletion']
  >;
  isChallengeActive: MockedMethod<First2FinishService['isChallengeActive']>;
  isFirst2FinishChallenge: MockedMethod<
    First2FinishService['isFirst2FinishChallenge']
  >;
};

describe('AutopilotService - handleSubmissionNotificationAggregate', () => {
  const createPayload = (
    overrides: Partial<SubmissionAggregatePayload> = {},
  ): SubmissionAggregatePayload => ({
    resource: 'submission',
    id: 'submission-1',
    originalTopic: 'submission.notification.create',
    v5ChallengeId: 'challenge-123',
    ...overrides,
  });

  let phaseScheduleManager: jest.Mocked<PhaseScheduleManager>;
  let resourceEventHandler: jest.Mocked<ResourceEventHandler>;
  let first2FinishService: First2FinishServiceMock;
  let schedulerService: jest.Mocked<SchedulerService>;
  let challengeApiService: jest.Mocked<ChallengeApiService>;
  let reviewService: jest.Mocked<ReviewService>;
  let configService: jest.Mocked<ConfigService>;
  let autopilotService: AutopilotService;

  beforeEach(() => {
    phaseScheduleManager = {
      schedulePhaseTransition: jest.fn(),
      cancelPhaseTransition: jest.fn(),
      reschedulePhaseTransition: jest.fn(),
      handlePhaseTransition: jest.fn(),
      handleNewChallenge: jest.fn(),
      handleChallengeUpdate: jest.fn(),
      cancelAllPhasesForChallenge: jest.fn(),
      processPhaseChain: jest.fn(),
      getActiveSchedulesSnapshot: jest.fn().mockReturnValue(new Map()),
    } as unknown as jest.Mocked<PhaseScheduleManager>;

    resourceEventHandler = {
      handleResourceCreated: jest.fn(),
      handleResourceDeleted: jest.fn(),
    } as unknown as jest.Mocked<ResourceEventHandler>;

    const handleSubmissionByChallengeId =
      createMockMethod<First2FinishService['handleSubmissionByChallengeId']>();
    handleSubmissionByChallengeId.mockResolvedValue(undefined);

    const handleIterativeReviewerAdded =
      createMockMethod<First2FinishService['handleIterativeReviewerAdded']>();
    const handleIterativeReviewCompletion =
      createMockMethod<
        First2FinishService['handleIterativeReviewCompletion']
      >();
    const isChallengeActive =
      createMockMethod<First2FinishService['isChallengeActive']>();
    isChallengeActive.mockReturnValue(true);
    const isFirst2FinishChallenge =
      createMockMethod<First2FinishService['isFirst2FinishChallenge']>();
    isFirst2FinishChallenge.mockReturnValue(true);

    first2FinishService = {
      handleSubmissionByChallengeId,
      handleIterativeReviewerAdded,
      handleIterativeReviewCompletion,
      isChallengeActive,
      isFirst2FinishChallenge,
    };

    schedulerService = {
      getAllScheduledTransitions: jest.fn().mockReturnValue([]),
      getAllScheduledTransitionsWithData: jest.fn().mockReturnValue(new Map()),
    } as unknown as jest.Mocked<SchedulerService>;

    challengeApiService = {
      getChallengeById: jest.fn(),
      advancePhase: jest.fn(),
      getPhaseTypeName: jest.fn(),
    } as unknown as jest.Mocked<ChallengeApiService>;

    reviewService = {
      getReviewById: jest.fn(),
      getActiveSubmissionCount: jest.fn(),
      getCompletedReviewCountForPhase: jest.fn(),
      getScorecardPassingScore: jest.fn(),
    } as unknown as jest.Mocked<ReviewService>;

    configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<ConfigService>;

    autopilotService = new AutopilotService(
      phaseScheduleManager,
      resourceEventHandler,
      first2FinishService,
      schedulerService,
      challengeApiService,
      reviewService,
      configService,
    );

    jest.clearAllMocks();
  });

  it('ignores messages that are not submission.create aggregates', async () => {
    await autopilotService.handleSubmissionNotificationAggregate(
      createPayload({ originalTopic: 'submission.notification.update' }),
    );

    expect(
      first2FinishService.handleSubmissionByChallengeId,
    ).not.toHaveBeenCalled();
  });

  it('ignores messages without a v5 challenge id', async () => {
    await autopilotService.handleSubmissionNotificationAggregate(
      createPayload({ v5ChallengeId: undefined }),
    );

    expect(
      first2FinishService.handleSubmissionByChallengeId,
    ).not.toHaveBeenCalled();
  });

  it('delegates to First2FinishService when payload is valid', async () => {
    await autopilotService.handleSubmissionNotificationAggregate(
      createPayload({ id: 'submission-123' }),
    );

    expect(
      first2FinishService.handleSubmissionByChallengeId,
    ).toHaveBeenCalledWith('challenge-123', 'submission-123');
  });
});
