import { SchedulerRegistry } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import type {
  IChallenge,
  IChallengeReviewer,
  IPhase,
} from '../../challenge/interfaces/challenge.interface';
import { ResourcesService } from '../../resources/resources.service';
import { ReviewAssignmentService } from './review-assignment.service';

const createPhase = (overrides: Partial<IPhase> = {}): IPhase => ({
  id: 'review-phase-instance',
  phaseId: 'review-phase-template',
  name: 'Review',
  description: null,
  isOpen: false,
  duration: 3600,
  scheduledStartDate: '2026-04-30T23:00:00.000Z',
  scheduledEndDate: '2026-05-01T00:00:00.000Z',
  actualStartDate: null,
  actualEndDate: null,
  predecessor: 'submission-phase-template',
  constraints: [],
  ...overrides,
});

const createReviewer = (
  overrides: Partial<IChallengeReviewer> = {},
): IChallengeReviewer => ({
  id: 'reviewer-config',
  scorecardId: 'scorecard-id',
  isMemberReview: true,
  memberReviewerCount: 1,
  phaseId: 'review-phase-template',
  baseCoefficient: null,
  incrementalCoefficient: null,
  type: null,
  aiWorkflowId: null,
  shouldOpenOpportunity: true,
  ...overrides,
});

const createChallenge = (overrides: Partial<IChallenge> = {}): IChallenge =>
  ({
    id: 'challenge-id',
    type: 'Code',
    phases: [createPhase()],
    reviewers: [createReviewer()],
    ...overrides,
  }) as IChallenge;

describe('ReviewAssignmentService', () => {
  let service: ReviewAssignmentService;
  let schedulerRegistry: jest.Mocked<SchedulerRegistry>;
  let configService: jest.Mocked<ConfigService>;
  let challengeApiService: jest.Mocked<ChallengeApiService>;
  let resourcesService: jest.Mocked<ResourcesService>;
  let addIntervalMock: jest.Mock;
  let getReviewerResourcesMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();

    addIntervalMock = jest.fn();
    getReviewerResourcesMock = jest.fn();

    schedulerRegistry = {
      addInterval: addIntervalMock,
      deleteInterval: jest.fn(),
      doesExist: jest.fn().mockReturnValue(false),
    } as unknown as jest.Mocked<SchedulerRegistry>;

    configService = {
      get: jest.fn(),
    } as unknown as jest.Mocked<ConfigService>;

    challengeApiService = {
      getChallengeById: jest.fn(),
    } as unknown as jest.Mocked<ChallengeApiService>;

    resourcesService = {
      getReviewerResources: getReviewerResourcesMock,
    } as unknown as jest.Mocked<ResourcesService>;

    service = new ReviewAssignmentService(
      schedulerRegistry,
      configService,
      challengeApiService,
      resourcesService,
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('allows Marathon Match review phases to open without assigned reviewer resources', async () => {
    const phase = createPhase();
    const openPhaseCallback = jest.fn();
    challengeApiService.getChallengeById.mockResolvedValue(
      createChallenge({
        type: 'Marathon Match',
        phases: [phase],
        reviewers: [createReviewer()],
      }),
    );

    const canOpen = await service.ensureAssignmentsOrSchedule(
      'challenge-id',
      phase,
      openPhaseCallback,
    );

    expect(canOpen).toBe(true);
    expect(getReviewerResourcesMock).not.toHaveBeenCalled();
    expect(addIntervalMock).not.toHaveBeenCalled();
    expect(openPhaseCallback).not.toHaveBeenCalled();
  });

  it('still defers non-Marathon Match review phases without assigned reviewer resources', async () => {
    const phase = createPhase();
    const openPhaseCallback = jest.fn();
    challengeApiService.getChallengeById.mockResolvedValue(
      createChallenge({
        type: 'Code',
        phases: [phase],
        reviewers: [createReviewer()],
      }),
    );
    getReviewerResourcesMock.mockResolvedValue([]);

    const canOpen = await service.ensureAssignmentsOrSchedule(
      'challenge-id',
      phase,
      openPhaseCallback,
    );

    expect(canOpen).toBe(false);
    expect(getReviewerResourcesMock).toHaveBeenCalledWith('challenge-id', [
      'Reviewer',
    ]);
    expect(addIntervalMock).toHaveBeenCalledTimes(1);
    expect(openPhaseCallback).not.toHaveBeenCalled();
  });
});
