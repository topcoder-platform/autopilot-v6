import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhaseReviewService } from './phase-review.service';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import type { IChallenge } from '../../challenge/interfaces/challenge.interface';
import {
  ReviewService,
  ActiveContestSubmission,
  SubmissionSummary,
} from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';
import { ChallengeCompletionService } from './challenge-completion.service';
import type { AutopilotDbLoggerService } from './autopilot-db-logger.service';
import {
  POST_MORTEM_REVIEWER_ROLE_NAME,
  ITERATIVE_REVIEW_PHASE_NAME,
} from '../constants/review.constants';
import { ReviewSummationApiService } from './review-summation-api.service';

const basePhase = {
  id: 'phase-1',
  phaseId: 'template-1',
  name: 'Review',
  description: null,
  isOpen: true,
  duration: 1000,
  scheduledStartDate: new Date().toISOString(),
  scheduledEndDate: new Date().toISOString(),
  actualStartDate: null,
  actualEndDate: null,
  predecessor: null,
  constraints: [],
};

const buildChallenge = (metadata: Record<string, string>): IChallenge => ({
  id: 'challenge-1',
  name: 'Test Challenge',
  description: null,
  descriptionFormat: 'markdown',
  projectId: 1,
  typeId: 'type-1',
  trackId: 'track-1',
  timelineTemplateId: 'timeline-1',
  currentPhaseNames: [],
  tags: [],
  groups: [],
  submissionStartDate: new Date().toISOString(),
  submissionEndDate: new Date().toISOString(),
  registrationStartDate: new Date().toISOString(),
  registrationEndDate: new Date().toISOString(),
  startDate: new Date().toISOString(),
  endDate: null,
  legacyId: null,
  status: 'ACTIVE',
  createdBy: 'test',
  updatedBy: 'test',
  metadata,
  phases: [{ ...basePhase }],
  reviewers: [
    {
      id: 'reviewer-config',
      scorecardId: 'scorecard-1',
      isMemberReview: true,
      memberReviewerCount: 1,
      phaseId: basePhase.phaseId,
      baseCoefficient: null,
      incrementalCoefficient: null,
      type: null,
      aiWorkflowId: null,
      shouldOpenOpportunity: true,
    },
  ],
  winners: [],
  discussions: [],
  events: [],
  prizeSets: [],
  terms: [],
  skills: [],
  attachments: [],
  track: 'Development',
  type: 'Development',
  legacy: {},
  task: {},
  created: new Date().toISOString(),
  updated: new Date().toISOString(),
  overview: {},
  numOfSubmissions: 0,
  numOfCheckpointSubmissions: 0,
  numOfRegistrants: 0,
});

describe('PhaseReviewService', () => {
  let loggerLogSpy: jest.SpyInstance;
  let loggerWarnSpy: jest.SpyInstance;
  let service: PhaseReviewService;
  let challengeApiService: jest.Mocked<ChallengeApiService>;
  let reviewService: jest.Mocked<ReviewService>;
  let resourcesService: jest.Mocked<ResourcesService>;
  let configService: jest.Mocked<ConfigService>;
  let challengeCompletionService: jest.Mocked<ChallengeCompletionService>;
  let reviewSummationApiService: jest.Mocked<ReviewSummationApiService>;
  let dbLogger: jest.Mocked<AutopilotDbLoggerService>;

  beforeAll(() => {
    loggerLogSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    loggerWarnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  beforeEach(() => {
    challengeApiService = {
      getChallengeById: jest.fn(),
    } as unknown as jest.Mocked<ChallengeApiService>;

    reviewService = {
      getActiveContestSubmissions: jest.fn(),
      getActiveCheckpointSubmissionIds: jest.fn(),
      getExistingReviewPairs: jest.fn(),
      createPendingReview: jest.fn(),
      getFailedScreeningSubmissionIds: jest.fn(),
      getCheckpointPassedSubmissionIds: jest.fn(),
      generateReviewSummaries: jest.fn(),
    } as unknown as jest.Mocked<ReviewService>;

    resourcesService = {
      getReviewerResources: jest.fn(),
      getResourcesByRoleNames: jest.fn(),
      getResourceById: jest.fn(),
      getRoleNameById: jest.fn(),
      hasSubmitterResource: jest.fn(),
      getMemberHandleMap: jest.fn(),
      getResourceByMemberHandle: jest.fn(),
      ensureResourcesForMembers: jest.fn(),
    } as unknown as jest.Mocked<ResourcesService>;

    configService = {
      get: jest.fn(),
    } as unknown as jest.Mocked<ConfigService>;

    challengeCompletionService = {
      finalizeChallenge: jest.fn(),
    } as unknown as jest.Mocked<ChallengeCompletionService>;
    reviewSummationApiService = {
      finalizeSummations: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<ReviewSummationApiService>;
    dbLogger = {
      logAction: jest.fn(),
    } as unknown as jest.Mocked<AutopilotDbLoggerService>;

    reviewService.getExistingReviewPairs.mockResolvedValue(new Set());
    resourcesService.getReviewerResources.mockResolvedValue([
      {
        id: 'resource-1',
        memberId: '111',
        memberHandle: 'member-111',
        roleName: 'Reviewer',
      },
    ] as any);
    resourcesService.ensureResourcesForMembers.mockResolvedValue([
      {
        id: 'post-mortem-resource-1',
        memberId: '111',
        memberHandle: 'member-111',
        roleName: 'Post-Mortem Reviewer',
      },
    ] as any);
    reviewService.createPendingReview.mockResolvedValue(true);
    reviewService.getFailedScreeningSubmissionIds.mockResolvedValue(new Set());
    reviewService.generateReviewSummaries.mockResolvedValue([]);
    reviewService.getActiveCheckpointSubmissionIds.mockResolvedValue([]);
    challengeCompletionService.finalizeChallenge.mockResolvedValue(true);

    service = new PhaseReviewService(
      challengeApiService,
      reviewService,
      resourcesService,
      configService,
      challengeCompletionService,
      reviewSummationApiService,
      dbLogger,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    loggerLogSpy?.mockRestore();
    loggerWarnSpy?.mockRestore();
  });

  it('creates reviews only for latest submissions when submissionLimit metadata is not set', async () => {
    const challenge = buildChallenge({});
    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    const submissions: ActiveContestSubmission[] = [
      { id: 'old-submission', memberId: '123', isLatest: false },
      { id: 'latest-submission', memberId: '123', isLatest: true },
      { id: 'unique-submission', memberId: null, isLatest: true },
    ];

    reviewService.getActiveContestSubmissions.mockResolvedValue(submissions);

    await service.handlePhaseOpened(challenge.id, challenge.phases[0].id);

    expect(reviewService.getActiveContestSubmissions).toHaveBeenCalledWith(
      challenge.id,
    );

    const createdSubmissionIds =
      reviewService.createPendingReview.mock.calls.map(
        (callArgs) => callArgs[0],
      );

    expect(createdSubmissionIds).toEqual([
      'latest-submission',
      'unique-submission',
    ]);
  });

  it('includes all submissions when submissionLimit metadata indicates unlimited', async () => {
    const submissionLimit = JSON.stringify({
      unlimited: 'true',
      limit: 'false',
      count: '',
    });
    const challenge = buildChallenge({ submissionLimit });
    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    const submissions: ActiveContestSubmission[] = [
      { id: 'old-submission', memberId: '123', isLatest: false },
      { id: 'latest-submission', memberId: '123', isLatest: true },
    ];

    reviewService.getActiveContestSubmissions.mockResolvedValue(submissions);

    await service.handlePhaseOpened(challenge.id, challenge.phases[0].id);

    const createdSubmissionIds =
      reviewService.createPendingReview.mock.calls.map(
        (callArgs) => callArgs[0],
      );

    expect(createdSubmissionIds).toEqual([
      'old-submission',
      'latest-submission',
    ]);
  });

  it('creates reviews only for latest submissions when the challenge enforces a submission limit', async () => {
    const submissionLimit = JSON.stringify({ limit: 'true', count: 2 });
    const challenge = buildChallenge({ submissionLimit });
    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    const submissions: ActiveContestSubmission[] = [
      { id: 'old-submission', memberId: '123', isLatest: false },
      { id: 'latest-submission', memberId: '123', isLatest: true },
    ];

    reviewService.getActiveContestSubmissions.mockResolvedValue(submissions);

    await service.handlePhaseOpened(challenge.id, challenge.phases[0].id);

    const createdSubmissionIds =
      reviewService.createPendingReview.mock.calls.map(
        (callArgs) => callArgs[0],
      );

    expect(createdSubmissionIds).toEqual(['latest-submission']);
    expect(createdSubmissionIds).not.toContain('old-submission');
  });

  it.each([
    ['string "null"', 'null'],
    ['malformed JSON string', '{"limit": }'],
    ['boolean true', true],
  ])(
    'treats %s submissionLimit as limited',
    async (_description, submissionLimit) => {
      const challenge = buildChallenge({
        submissionLimit,
      } as any);
      challengeApiService.getChallengeById.mockResolvedValue(challenge);

      const submissions: ActiveContestSubmission[] = [
        { id: 'old-submission', memberId: '123', isLatest: false },
        { id: 'latest-submission', memberId: '123', isLatest: true },
      ];

      reviewService.getActiveContestSubmissions.mockResolvedValue(submissions);

      await service.handlePhaseOpened(challenge.id, challenge.phases[0].id);

      const createdSubmissionIds =
        reviewService.createPendingReview.mock.calls.map(
          (callArgs) => callArgs[0],
        );

      expect(createdSubmissionIds).toEqual(['latest-submission']);

      const warningMessages = loggerWarnSpy.mock.calls.map(
        ([message]) => message as string,
      );
      expect(warningMessages).toEqual(
        expect.arrayContaining([
          expect.stringContaining('defaulting to limited submissions.'),
        ]),
      );
    },
  );

  it('skips non-latest submissions without member IDs when a limit is enforced', async () => {
    const submissionLimit = JSON.stringify({ limit: 'true', count: 1 });
    const challenge = buildChallenge({ submissionLimit });
    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    const submissions: ActiveContestSubmission[] = [
      { id: 'legacy-submission', memberId: null, isLatest: false },
      { id: 'latest-submission', memberId: null, isLatest: true },
    ];

    reviewService.getActiveContestSubmissions.mockResolvedValue(submissions);

    await service.handlePhaseOpened(challenge.id, challenge.phases[0].id);

    const createdSubmissionIds =
      reviewService.createPendingReview.mock.calls.map(
        (callArgs) => callArgs[0],
      );

    expect(createdSubmissionIds).toEqual(['latest-submission']);
  });

  it('omits submissions that failed screening', async () => {
    const challenge = buildChallenge({});
    const screeningPhase = {
      ...basePhase,
      id: 'phase-screening',
      phaseId: 'template-screening',
      name: 'Screening',
    };
    challenge.phases = [{ ...basePhase }, screeningPhase];
    challenge.reviewers.push({
      id: 'screening-config',
      scorecardId: 'screening-scorecard',
      isMemberReview: false,
      memberReviewerCount: 1,
      phaseId: screeningPhase.phaseId,
      baseCoefficient: null,
      incrementalCoefficient: null,
      type: null,
      aiWorkflowId: null,
      shouldOpenOpportunity: true,
    });

    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    const submissions: ActiveContestSubmission[] = [
      { id: 'failed-submission', memberId: '123', isLatest: true },
      { id: 'passed-submission', memberId: '456', isLatest: true },
    ];

    reviewService.getActiveContestSubmissions.mockResolvedValue(submissions);
    reviewService.getFailedScreeningSubmissionIds.mockResolvedValue(
      new Set(['failed-submission']),
    );

    await service.handlePhaseOpened(challenge.id, basePhase.id);

    expect(reviewService.getFailedScreeningSubmissionIds).toHaveBeenCalledWith(
      challenge.id,
      ['screening-scorecard'],
    );

    const createdSubmissionIds =
      reviewService.createPendingReview.mock.calls.map(
        (callArgs) => callArgs[0],
      );

    expect(createdSubmissionIds).toEqual(['passed-submission']);
  });

  it('creates post-mortem pending reviews for Post-Mortem Reviewer resources', async () => {
    const challenge = buildChallenge({});
    const postMortemPhase = {
      ...basePhase,
      id: 'post-mortem-phase',
      name: 'Post-Mortem',
    };
    challenge.phases = [postMortemPhase];
    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    configService.get.mockImplementation((key: string) =>
      key === 'autopilot.postMortemScorecardId' ? 'scorecard-123' : null,
    );

    const sourceResources = [
      {
        id: 'reviewer-resource',
        memberId: '301',
        memberHandle: 'reviewer1',
        roleName: 'Reviewer',
      },
      {
        id: 'copilot-resource',
        memberId: '201',
        memberHandle: 'copilot1',
        roleName: 'Copilot',
      },
    ];

    const postMortemResources = [
      {
        id: 'pm-resource-1',
        memberId: '301',
        memberHandle: 'reviewer1',
        roleName: POST_MORTEM_REVIEWER_ROLE_NAME,
      },
      {
        id: 'pm-resource-2',
        memberId: '201',
        memberHandle: 'copilot1',
        roleName: POST_MORTEM_REVIEWER_ROLE_NAME,
      },
    ];

    resourcesService.getReviewerResources.mockResolvedValueOnce(
      sourceResources as any,
    );
    resourcesService.ensureResourcesForMembers.mockResolvedValueOnce(
      postMortemResources as any,
    );

    await service.handlePhaseOpenedForChallenge(challenge, postMortemPhase.id);

    expect(resourcesService.ensureResourcesForMembers).toHaveBeenCalledWith(
      challenge.id,
      sourceResources,
      POST_MORTEM_REVIEWER_ROLE_NAME,
    );
    expect(reviewService.createPendingReview).toHaveBeenCalledTimes(
      postMortemResources.length,
    );
    expect(reviewService.createPendingReview).toHaveBeenCalledWith(
      null,
      'pm-resource-1',
      postMortemPhase.id,
      'scorecard-123',
      challenge.id,
    );
    expect(reviewService.createPendingReview).toHaveBeenCalledWith(
      null,
      'pm-resource-2',
      postMortemPhase.id,
      'scorecard-123',
      challenge.id,
    );
  });

  it('assigns approval review to the highest passing submission', async () => {
    const challenge = buildChallenge({});
    challenge.phases[0].name = 'Approval';
    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    const summaries: SubmissionSummary[] = [
      {
        submissionId: 'winner',
        legacySubmissionId: null,
        memberId: '111',
        submittedDate: new Date('2024-04-01T00:00:00Z'),
        aggregateScore: 96,
        scorecardId: 'scorecard-1',
        scorecardLegacyId: null,
        passingScore: 86,
        isPassing: true,
      },
      {
        submissionId: 'runner-up',
        legacySubmissionId: null,
        memberId: '222',
        submittedDate: new Date('2024-04-02T00:00:00Z'),
        aggregateScore: 92,
        scorecardId: 'scorecard-1',
        scorecardLegacyId: null,
        passingScore: 86,
        isPassing: true,
      },
      {
        submissionId: 'failing-submission',
        legacySubmissionId: null,
        memberId: '333',
        submittedDate: new Date('2024-04-03T00:00:00Z'),
        aggregateScore: 40,
        scorecardId: 'scorecard-1',
        scorecardLegacyId: null,
        passingScore: 86,
        isPassing: false,
      },
    ];
    reviewService.generateReviewSummaries.mockResolvedValue(summaries);

    await service.handlePhaseOpened(challenge.id, challenge.phases[0].id);

    expect(reviewSummationApiService.finalizeSummations).toHaveBeenCalledTimes(
      1,
    );
    expect(reviewSummationApiService.finalizeSummations).toHaveBeenCalledWith(
      challenge.id,
    );
    expect(reviewService.generateReviewSummaries).toHaveBeenCalledWith(
      challenge.id,
    );
    expect(reviewService.createPendingReview).toHaveBeenCalledWith(
      'winner',
      'resource-1',
      challenge.phases[0].id,
      'scorecard-1',
      challenge.id,
    );
    expect(challengeCompletionService.finalizeChallenge).not.toHaveBeenCalled();
  });

  it('cancels the challenge when approval opens without passing submissions', async () => {
    const challenge = buildChallenge({});
    challenge.phases[0].name = 'Approval';
    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    const summaries: SubmissionSummary[] = [
      {
        submissionId: 'failing-submission',
        legacySubmissionId: null,
        memberId: '333',
        submittedDate: new Date('2024-04-03T00:00:00Z'),
        aggregateScore: 40,
        scorecardId: 'scorecard-1',
        scorecardLegacyId: null,
        passingScore: 86,
        isPassing: false,
      },
    ];
    reviewService.generateReviewSummaries.mockResolvedValue(summaries);

    await service.handlePhaseOpened(challenge.id, challenge.phases[0].id);

    expect(reviewSummationApiService.finalizeSummations).toHaveBeenCalledTimes(
      1,
    );
    expect(reviewSummationApiService.finalizeSummations).toHaveBeenCalledWith(
      challenge.id,
    );
    expect(challengeCompletionService.finalizeChallenge).toHaveBeenCalledWith(
      challenge.id,
    );
    expect(reviewService.createPendingReview).not.toHaveBeenCalled();
  });

  it('uses checkpoint reviewer resources when checkpoint review phase opens', async () => {
    const challenge = buildChallenge({});
    const checkpointPhase = {
      ...basePhase,
      id: 'phase-checkpoint-review',
      phaseId: 'template-checkpoint-review',
      name: 'Checkpoint Review',
    };
    const screeningPhase = {
      ...basePhase,
      id: 'phase-screening',
      phaseId: 'template-screening',
      name: 'Checkpoint Screening',
    };

    challenge.phases = [checkpointPhase, screeningPhase];

    const baseReviewerConfig = challenge.reviewers[0];
    challenge.reviewers = [
      {
        ...baseReviewerConfig,
        id: 'checkpoint-config',
        phaseId: checkpointPhase.phaseId,
        scorecardId: 'checkpoint-scorecard',
      },
      {
        ...baseReviewerConfig,
        id: 'screening-config',
        phaseId: screeningPhase.phaseId,
        scorecardId: 'screening-scorecard',
        isMemberReview: false,
      },
    ];

    challengeApiService.getChallengeById.mockResolvedValue(challenge);
    resourcesService.getReviewerResources.mockResolvedValue([
      { id: 'checkpoint-resource' },
    ] as any);
    reviewService.getCheckpointPassedSubmissionIds.mockResolvedValue([
      'submission-1',
    ]);

    await service.handlePhaseOpened(challenge.id, checkpointPhase.id);

    expect(resourcesService.getReviewerResources).toHaveBeenCalledWith(
      challenge.id,
      ['Checkpoint Reviewer'],
    );
    expect(reviewService.getCheckpointPassedSubmissionIds).toHaveBeenCalledWith(
      challenge.id,
      'screening-scorecard',
    );
    expect(reviewService.createPendingReview).toHaveBeenCalledWith(
      'submission-1',
      'checkpoint-resource',
      checkpointPhase.id,
      'checkpoint-scorecard',
      challenge.id,
    );
  });

  it('does not create pending reviews when an iterative review phase opens', async () => {
    const iterativePhase = {
      ...basePhase,
      id: 'iterative-phase',
      name: ITERATIVE_REVIEW_PHASE_NAME,
    };

    const challenge = buildChallenge({});
    challenge.phases = [iterativePhase];

    await service.handlePhaseOpenedForChallenge(challenge, iterativePhase.id);

    expect(reviewService.createPendingReview).not.toHaveBeenCalled();
    expect(dbLogger.logAction).toHaveBeenCalledWith(
      'review.preparePendingReviews',
      expect.objectContaining({
        challengeId: challenge.id,
        status: 'INFO',
        source: PhaseReviewService.name,
        details: expect.objectContaining({
          phaseId: iterativePhase.id,
          phaseName: ITERATIVE_REVIEW_PHASE_NAME,
          reason: 'iterative-phase-delegated',
        }),
      }),
    );
  });
});
