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
import { AutopilotOperator, PhaseTransitionPayload } from '../interfaces/autopilot.interface';

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

describe('SchedulerService (review phase deferral)', () => {
  let scheduler: SchedulerService;
  let kafkaService: jest.Mocked<KafkaService>;
  let challengeApiService: jest.Mocked<ChallengeApiService>;
  let phaseReviewService: jest.Mocked<PhaseReviewService>;
  let challengeCompletionService: jest.Mocked<ChallengeCompletionService>;
  let reviewService: jest.Mocked<ReviewService>;

  beforeEach(() => {
    kafkaService = {
      produce: jest.fn(),
    } as unknown as jest.Mocked<KafkaService>;

    challengeApiService = {
      getPhaseDetails: jest.fn(),
      advancePhase: jest.fn(),
      getChallengePhases: jest.fn(),
    } as unknown as jest.Mocked<ChallengeApiService>;

    phaseReviewService = {
      handlePhaseOpened: jest.fn(),
    } as unknown as jest.Mocked<PhaseReviewService>;

    challengeCompletionService = {
      finalizeChallenge: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<ChallengeCompletionService>;

    reviewService = {
      getPendingReviewCount: jest.fn(),
    } as unknown as jest.Mocked<ReviewService>;

    scheduler = new SchedulerService(
      kafkaService,
      challengeApiService,
      phaseReviewService,
      challengeCompletionService,
      reviewService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('defers closing review phases when pending reviews exist', async () => {
    const payload = createPayload();
    const phaseDetails = {
      id: payload.phaseId,
      name: 'Review',
      isOpen: true,
    };

    challengeApiService.getPhaseDetails.mockResolvedValue(phaseDetails as any);
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
    expect(new Date(rescheduledPayload.date as string).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('closes review phases when no pending reviews remain', async () => {
    const payload = createPayload();
    const phaseDetails = {
      id: payload.phaseId,
      name: 'Review',
      isOpen: true,
    };

    challengeApiService.getPhaseDetails.mockResolvedValue(phaseDetails as any);
    reviewService.getPendingReviewCount.mockResolvedValue(0);
    challengeApiService.advancePhase.mockResolvedValue({
      success: true,
      message: 'closed',
      updatedPhases: [
        {
          id: payload.phaseId,
          isOpen: false,
          actualEndDate: new Date().toISOString(),
        },
      ],
    } as any);

    await scheduler.advancePhase(payload);

    expect(reviewService.getPendingReviewCount).toHaveBeenCalled();
    expect(challengeApiService.advancePhase).toHaveBeenCalledWith(
      payload.challengeId,
      payload.phaseId,
      'close',
    );
  });
});
