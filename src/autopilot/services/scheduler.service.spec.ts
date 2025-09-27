jest.mock('../../kafka/kafka.service', () => ({
  KafkaService: jest.fn().mockImplementation(() => ({
    produce: jest.fn(),
  })),
}));

import { SchedulerService } from './scheduler.service';
import { KafkaService } from '../../kafka/kafka.service';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { PhaseReviewService } from './phase-review.service';
import { ChallengeCompletionService } from './challenge-completion.service';
import { ReviewService } from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';
import { ConfigService } from '@nestjs/config';
import type { IPhase } from '../../challenge/interfaces/challenge.interface';
import {
  AutopilotOperator,
  PhaseTransitionPayload,
} from '../interfaces/autopilot.interface';

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
};

type ReviewServiceMock = {
  getPendingReviewCount: MockedMethod<ReviewService['getPendingReviewCount']>;
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
  let challengeCompletionService: jest.Mocked<ChallengeCompletionService>;
  let reviewService: ReviewServiceMock;
  let resourcesService: jest.Mocked<ResourcesService>;
  let configService: jest.Mocked<ConfigService>;

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
    };

    phaseReviewService = {
      handlePhaseOpened: jest.fn(),
    } as unknown as jest.Mocked<PhaseReviewService>;

    challengeCompletionService = {
      finalizeChallenge: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<ChallengeCompletionService>;

    reviewService = {
      getPendingReviewCount:
        createMockMethod<ReviewService['getPendingReviewCount']>(),
    };

    resourcesService = {
      hasSubmitterResource: jest.fn().mockResolvedValue(true),
      getResourcesByRoleNames: jest.fn().mockResolvedValue([]),
      getReviewerResources: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<ResourcesService>;

    configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<ConfigService>;

    scheduler = new SchedulerService(
      kafkaService as unknown as KafkaService,
      challengeApiService as unknown as ChallengeApiService,
      phaseReviewService,
      challengeCompletionService,
      reviewService as unknown as ReviewService,
      resourcesService,
      configService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
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
});
