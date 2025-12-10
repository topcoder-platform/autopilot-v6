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
import type { ChallengeCompletionService } from './challenge-completion.service';
import {
  ITERATIVE_REVIEW_PHASE_NAME,
  REGISTRATION_PHASE_NAME,
  SUBMISSION_PHASE_NAME,
} from '../constants/review.constants';

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
  fixedAmount: 0,
  baseCoefficient: null,
  incrementalCoefficient: null,
  type: null,
  aiWorkflowId: null,
  shouldOpenOpportunity: true,
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
  metadata: {},
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
  let challengeCompletionService: jest.Mocked<ChallengeCompletionService>;
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
      getReviewerSubmissionPairs: jest.fn(),
      createPendingReview: jest.fn(),
      getPendingReviewCount: jest.fn(),
      getScorecardPassingScore: jest.fn(),
    } as unknown as jest.Mocked<ReviewService>;

    resourcesService = {
      getReviewerResources: jest.fn(),
      getMemberHandleMap: jest.fn(),
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

    challengeCompletionService = {
      completeChallengeWithWinners: jest.fn(),
    } as unknown as jest.Mocked<ChallengeCompletionService>;

    service = new First2FinishService(
      challengeApiService,
      schedulerService,
      reviewService,
      resourcesService,
      configService,
      challengeCompletionService,
    );

    reviewService.getReviewerSubmissionPairs.mockResolvedValue(new Set());
    reviewService.getPendingReviewCount.mockResolvedValue(0);
    resourcesService.getMemberHandleMap.mockResolvedValue(new Map());
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

  it('keeps the active iterative review phase open when no submissions are available', async () => {
    const activePhase = buildIterativePhase({
      isOpen: true,
      actualEndDate: null,
    });

    const challenge = buildChallenge({
      phases: [activePhase],
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
    reviewService.getExistingReviewPairs.mockResolvedValue(new Set());

    await service.handleSubmissionByChallengeId(challenge.id);

    expect(reviewService.createPendingReview).not.toHaveBeenCalled();
    expect(schedulerService.advancePhase).not.toHaveBeenCalled();
    expect(schedulerService.schedulePhaseTransition).not.toHaveBeenCalled();
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

  it('closes the active iterative phase before assigning the next submission when a prior iteration finished', async () => {
    const completedPhase = buildIterativePhase({
      id: 'iterative-phase-1',
      isOpen: false,
      actualEndDate: iso(),
    });
    const activePhase = buildIterativePhase({
      id: 'iterative-phase-2',
      isOpen: true,
      actualEndDate: null,
      predecessor: completedPhase.id,
    });

    const challenge = buildChallenge({
      phases: [completedPhase, activePhase],
      reviewers: [buildReviewer()],
      numOfSubmissions: 2,
    });

    const nextPhase = buildIterativePhase({
      id: 'iterative-phase-3',
      isOpen: true,
      actualEndDate: null,
      predecessor: activePhase.id,
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

    reviewService.getExistingReviewPairs.mockResolvedValue(new Set());
    reviewService.getAllSubmissionIdsOrdered.mockResolvedValue([
      'sub-3',
      'sub-2',
      'sub-1',
    ]);
    reviewService.createPendingReview.mockResolvedValue(true);

    await service.handleSubmissionByChallengeId(challenge.id, 'sub-3');

    expect(schedulerService.advancePhase).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: challenge.id,
        phaseId: activePhase.id,
        state: 'END',
      }),
    );

    expect(challengeApiService.createIterativeReviewPhase).toHaveBeenCalledWith(
      challenge.id,
      activePhase.id,
      activePhase.phaseId,
      activePhase.name,
      activePhase.description,
      expect.any(Number),
    );

    expect(reviewService.createPendingReview).toHaveBeenCalledWith(
      'sub-3',
      'resource-1',
      nextPhase.id,
      'iterative-scorecard',
      challenge.id,
    );

    expect(schedulerService.schedulePhaseTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: challenge.id,
        phaseId: nextPhase.id,
      }),
    );
  });

  it('closes submission and registration after a passing iterative review', async () => {
    const iterativePhase = buildIterativePhase({
      id: 'iter-phase',
      isOpen: true,
      actualEndDate: null,
    });
    const submissionPhase = buildIterativePhase({
      id: 'submission-phase',
      name: SUBMISSION_PHASE_NAME,
      isOpen: true,
      actualEndDate: null,
    });
    const registrationPhase = buildIterativePhase({
      id: 'registration-phase',
      name: REGISTRATION_PHASE_NAME,
      isOpen: true,
      actualEndDate: null,
    });

    const challenge = buildChallenge({
      phases: [iterativePhase, submissionPhase, registrationPhase],
      reviewers: [buildReviewer()],
    });

    reviewService.getScorecardPassingScore.mockResolvedValue(90);

    await service.handleIterativeReviewCompletion(
      challenge,
      iterativePhase,
      {
        score: 95,
        scorecardId: 'iterative-scorecard',
        resourceId: 'resource-1',
        submissionId: 'submission-1',
        phaseId: iterativePhase.id,
      },
      {
        reviewId: 'review-1',
        challengeId: challenge.id,
        submissionId: 'submission-1',
        phaseId: iterativePhase.id,
        scorecardId: 'iterative-scorecard',
        reviewerResourceId: 'resource-1',
        reviewerHandle: 'iterativeReviewer',
        reviewerMemberId: '2001',
        submitterHandle: 'submitter',
        submitterMemberId: '4001',
        completedAt: iso(),
        initialScore: 95,
      },
    );

    expect(schedulerService.advancePhase).toHaveBeenCalledTimes(3);
    expect(schedulerService.advancePhase).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        phaseId: iterativePhase.id,
        state: 'END',
        skipIterativePhaseRefresh: true,
      }),
    );
    expect(schedulerService.advancePhase).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        phaseId: submissionPhase.id,
        state: 'END',
      }),
    );
    expect(schedulerService.advancePhase).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        phaseId: registrationPhase.id,
        state: 'END',
      }),
    );

    expect(challengeCompletionService.completeChallengeWithWinners).toHaveBeenCalledWith(
      challenge.id,
      [
        {
          handle: 'submitter',
          placement: 1,
          userId: 4001,
        },
      ],
      { reason: 'iterative-review-pass' },
    );
  });

  it('uses member handle map when completing after a passing iterative review', async () => {
    const iterativePhase = buildIterativePhase({
      id: 'iter-phase',
      isOpen: true,
      actualEndDate: null,
    });

    const challenge = buildChallenge({
      phases: [iterativePhase],
      reviewers: [buildReviewer()],
    });

    resourcesService.getMemberHandleMap.mockResolvedValue(
      new Map([['4001', 'resolvedHandle']]),
    );
    reviewService.getScorecardPassingScore.mockResolvedValue(80);

    await service.handleIterativeReviewCompletion(
      challenge,
      iterativePhase,
      {
        score: 90,
        scorecardId: 'iterative-scorecard',
        resourceId: 'resource-1',
        submissionId: 'submission-1',
        phaseId: iterativePhase.id,
      },
      {
        reviewId: 'review-1',
        challengeId: challenge.id,
        submissionId: 'submission-1',
        phaseId: iterativePhase.id,
        scorecardId: 'iterative-scorecard',
        reviewerResourceId: 'resource-1',
        reviewerHandle: 'iterativeReviewer',
        reviewerMemberId: '2001',
        submitterHandle: 'submitter',
        submitterMemberId: '4001',
        completedAt: iso(),
        initialScore: 90,
      },
    );

    expect(challengeCompletionService.completeChallengeWithWinners).toHaveBeenCalledWith(
      challenge.id,
      [
        {
          handle: 'resolvedHandle',
          placement: 1,
          userId: 4001,
        },
      ],
      { reason: 'iterative-review-pass' },
    );
  });
});
