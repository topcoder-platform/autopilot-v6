jest.mock('../../kafka/kafka.service', () => ({
  KafkaService: jest.fn().mockImplementation(() => ({})),
}));

import { First2FinishService } from './first2finish.service';
import type { ChallengeApiService } from '../../challenge/challenge-api.service';
import type { SchedulerService } from './scheduler.service';
import type { ReviewService } from '../../review/review.service';
import type { ResourcesService } from '../../resources/resources.service';
import type { ConfigService } from '@nestjs/config';
import type {
  IChallenge,
  IPhase,
  IChallengeReviewer,
} from '../../challenge/interfaces/challenge.interface';
import { ITERATIVE_REVIEW_PHASE_NAME } from '../constants/review.constants';

const iso = () => new Date().toISOString();

const buildIterativePhase = (overrides: Partial<IPhase> = {}): IPhase => ({
  id: 'iterative-phase-1',
  phaseId: 'iterative-template',
  name: ITERATIVE_REVIEW_PHASE_NAME,
  description: null,
  isOpen: false,
  duration: 86400,
  scheduledStartDate: iso(),
  scheduledEndDate: iso(),
  actualStartDate: iso(),
  actualEndDate: iso(),
  predecessor: null,
  constraints: [],
  ...overrides,
});

const buildReviewer = (
  overrides: Partial<IChallengeReviewer> = {},
): IChallengeReviewer => ({
  id: 'reviewer-config-1',
  scorecardId: 'iterative-scorecard',
  isMemberReview: true,
  memberReviewerCount: 1,
  phaseId: 'iterative-template',
  basePayment: null,
  incrementalPayment: null,
  type: null,
  aiWorkflowId: null,
  ...overrides,
});

const buildChallenge = (overrides: Partial<IChallenge> = {}): IChallenge => ({
  id: 'challenge-1',
  name: 'Test',
  description: null,
  descriptionFormat: 'markdown',
  projectId: 123,
  typeId: 'type',
  trackId: 'track',
  timelineTemplateId: 'timeline',
  currentPhaseNames: [],
  tags: [],
  groups: [],
  submissionStartDate: iso(),
  submissionEndDate: iso(),
  registrationStartDate: iso(),
  registrationEndDate: iso(),
  startDate: iso(),
  endDate: null,
  legacyId: null,
  status: 'ACTIVE',
  createdBy: 'tester',
  updatedBy: 'tester',
  metadata: [],
  phases: [],
  reviewers: [],
  winners: [],
  discussions: [],
  events: [],
  prizeSets: [],
  terms: [],
  skills: [],
  attachments: [],
  track: 'DEVELOP',
  type: 'first2finish',
  legacy: {},
  task: {},
  created: iso(),
  updated: iso(),
  overview: {},
  numOfSubmissions: 0,
  numOfCheckpointSubmissions: 0,
  numOfRegistrants: 0,
  ...overrides,
});

describe('First2FinishService', () => {
  let challengeApiService: jest.Mocked<ChallengeApiService>;
  let schedulerService: jest.Mocked<SchedulerService>;
  let reviewService: jest.Mocked<ReviewService>;
  let resourcesService: jest.Mocked<ResourcesService>;
  let configService: jest.Mocked<ConfigService>;
  let service: First2FinishService;

  beforeEach(() => {
    jest.useFakeTimers();

    challengeApiService = {
      getChallengeById: jest.fn(),
      createIterativeReviewPhase: jest.fn(),
      getPhaseDetails: jest.fn(),
    } as unknown as jest.Mocked<ChallengeApiService>;

    schedulerService = {
      advancePhase: jest.fn(),
      schedulePhaseTransition: jest.fn(),
    } as unknown as jest.Mocked<SchedulerService>;

    reviewService = {
      getAllSubmissionIdsOrdered: jest.fn(),
      getExistingReviewPairs: jest.fn(),
      createPendingReview: jest.fn(),
      getScorecardPassingScore: jest.fn(),
    } as unknown as jest.Mocked<ReviewService>;

    resourcesService = {
      getReviewerResources: jest.fn(),
    } as unknown as jest.Mocked<ResourcesService>;

    configService = {
      get: jest.fn((key: string) => {
        if (key === 'autopilot.iterativeReviewDurationHours') {
          return 24;
        }
        if (key === 'autopilot.iterativeReviewAssignmentRetrySeconds') {
          return 30;
        }
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    service = new First2FinishService(
      challengeApiService,
      schedulerService,
      reviewService,
      resourcesService,
      configService,
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('skips creating a new iterative review phase when no submissions exist', async () => {
    const challenge = buildChallenge({
      phases: [buildIterativePhase({ isOpen: false })],
      reviewers: [buildReviewer()],
    });

    challengeApiService.getChallengeById.mockResolvedValue(challenge);
    resourcesService.getReviewerResources.mockResolvedValue([
      {
        id: 'resource-1',
        memberId: '2001',
        memberHandle: 'iterativeReviewer',
        roleName: 'Iterative Reviewer',
      },
    ]);
    reviewService.getAllSubmissionIdsOrdered.mockResolvedValue([]);

    await service.handleSubmissionByChallengeId(challenge.id);

    expect(
      challengeApiService.createIterativeReviewPhase,
    ).not.toHaveBeenCalled();
    expect(schedulerService.advancePhase).not.toHaveBeenCalled();
  });

  it('reopens the seeded iterative review phase when the first submission arrives', async () => {
    const seedPhase = buildIterativePhase({
      isOpen: false,
      actualStartDate: null,
      actualEndDate: null,
    });

    const challenge = buildChallenge({
      phases: [seedPhase],
      reviewers: [buildReviewer()],
    });

    const reopenedPhase: IPhase = {
      ...seedPhase,
      isOpen: true,
      actualStartDate: iso(),
      actualEndDate: null,
    };

    challengeApiService.getChallengeById.mockResolvedValue(challenge);
    challengeApiService.getPhaseDetails.mockResolvedValue(reopenedPhase);

    resourcesService.getReviewerResources.mockResolvedValue([
      {
        id: 'resource-1',
        memberId: '2001',
        memberHandle: 'iterativeReviewer',
        roleName: 'Iterative Reviewer',
      },
    ]);

    reviewService.getAllSubmissionIdsOrdered.mockResolvedValue(['sub-123']);
    reviewService.getExistingReviewPairs.mockResolvedValue(new Set());
    reviewService.createPendingReview.mockResolvedValue(true);

    await service.handleSubmissionByChallengeId(challenge.id, 'sub-123');

    expect(
      challengeApiService.createIterativeReviewPhase,
    ).not.toHaveBeenCalled();
    expect(schedulerService.advancePhase).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: challenge.id,
        phaseId: seedPhase.id,
        state: 'START',
      }),
    );
    expect(challengeApiService.getPhaseDetails).toHaveBeenCalledWith(
      challenge.id,
      seedPhase.id,
    );
    expect(reviewService.createPendingReview).toHaveBeenCalledWith(
      'sub-123',
      'resource-1',
      seedPhase.id,
      'iterative-scorecard',
      challenge.id,
    );
    expect(schedulerService.schedulePhaseTransition).toHaveBeenCalled();
  });

  it('assigns the preferred submission when the list snapshot is empty', async () => {
    const closedPhase = buildIterativePhase({ isOpen: false });
    const challenge = buildChallenge({
      phases: [closedPhase],
      reviewers: [buildReviewer()],
    });

    const nextPhase = buildIterativePhase({
      id: 'iterative-phase-2',
      isOpen: true,
      actualEndDate: null,
      predecessor: closedPhase.phaseId,
    });

    challengeApiService.getChallengeById.mockResolvedValue(challenge);
    challengeApiService.createIterativeReviewPhase.mockResolvedValue(nextPhase);

    resourcesService.getReviewerResources.mockResolvedValue([
      {
        id: 'resource-1',
        memberId: '2001',
        memberHandle: 'iterativeReviewer',
        roleName: 'Iterative Reviewer',
      },
    ]);

    reviewService.getAllSubmissionIdsOrdered.mockResolvedValue([]);
    reviewService.getExistingReviewPairs.mockResolvedValue(new Set());
    reviewService.createPendingReview.mockResolvedValue(true);

    await service.handleSubmissionByChallengeId(challenge.id, 'sub-123');

    expect(
      challengeApiService.createIterativeReviewPhase,
    ).toHaveBeenCalledWith(
      challenge.id,
      closedPhase.id,
      closedPhase.phaseId,
      closedPhase.name,
      closedPhase.description,
      expect.any(Number),
    );

    expect(reviewService.createPendingReview).toHaveBeenCalledWith(
      'sub-123',
      'resource-1',
      nextPhase.id,
      'iterative-scorecard',
      challenge.id,
    );

    expect(schedulerService.advancePhase).not.toHaveBeenCalled();
    expect(schedulerService.schedulePhaseTransition).toHaveBeenCalled();
  });
});
