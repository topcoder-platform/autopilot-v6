import { PhaseReviewService } from './phase-review.service';
import type { ChallengeApiService } from '../../challenge/challenge-api.service';
import type {
  IChallenge,
  IPhase,
} from '../../challenge/interfaces/challenge.interface';
import type {
  ActiveContestSubmission,
  ReviewService,
} from '../../review/review.service';
import type {
  ResourcesService,
  ReviewerResourceRecord,
} from '../../resources/resources.service';
import type { ConfigService } from '@nestjs/config';
import type { MarathonMatchReviewService } from '../../marathon-match/marathon-match-review.service';
import type { ChallengeCompletionService } from './challenge-completion.service';
import type { ReviewSummationApiService } from './review-summation-api.service';
import type { AutopilotDbLoggerService } from './autopilot-db-logger.service';

const createMockMethod = <T extends (...args: any[]) => any>() =>
  jest.fn<ReturnType<T>, Parameters<T>>();

const baseReviewPhase: IPhase = {
  id: 'review-phase',
  phaseId: 'review-template',
  name: 'Review',
  description: null,
  isOpen: true,
  duration: 3600,
  scheduledStartDate: new Date('2026-01-01T00:00:00Z').toISOString(),
  scheduledEndDate: new Date('2026-01-02T00:00:00Z').toISOString(),
  actualStartDate: new Date('2026-01-01T00:00:00Z').toISOString(),
  actualEndDate: null,
  predecessor: null,
  constraints: [],
};

const buildChallenge = (
  phase: IPhase,
  reviewers = [
    {
      id: 'reviewer-config',
      scorecardId: 'scorecard-1',
      isMemberReview: true,
      memberReviewerCount: 1,
      phaseId: phase.phaseId,
      fixedAmount: 0,
      baseCoefficient: null,
      incrementalCoefficient: null,
      type: null,
      aiWorkflowId: null,
      shouldOpenOpportunity: true,
    },
  ],
  metadata: Record<string, string> = {},
  phases: IPhase[] = [phase],
): IChallenge => ({
  id: 'challenge-1',
  name: 'Challenge',
  description: null,
  descriptionFormat: 'markdown',
  projectId: 1001,
  typeId: 'type-1',
  trackId: 'track-1',
  timelineTemplateId: 'timeline-1',
  currentPhaseNames: [phase.name],
  tags: [],
  groups: [],
  submissionStartDate: new Date('2026-01-01T00:00:00Z').toISOString(),
  submissionEndDate: new Date('2026-01-02T00:00:00Z').toISOString(),
  registrationStartDate: new Date('2025-12-31T00:00:00Z').toISOString(),
  registrationEndDate: new Date('2026-01-01T00:00:00Z').toISOString(),
  startDate: new Date('2025-12-31T00:00:00Z').toISOString(),
  endDate: null,
  legacyId: null,
  status: 'ACTIVE',
  createdBy: 'tester',
  updatedBy: 'tester',
  metadata,
  phases,
  reviewers,
  winners: [],
  discussions: [],
  events: [],
  prizeSets: [],
  terms: [],
  skills: [],
  attachments: [],
  track: 'DEVELOP',
  type: 'Code',
  legacy: {},
  task: {},
  created: new Date('2025-12-31T00:00:00Z').toISOString(),
  updated: new Date('2026-01-01T00:00:00Z').toISOString(),
  overview: {},
  numOfSubmissions: 0,
  numOfCheckpointSubmissions: 0,
  numOfRegistrants: 0,
});

describe('PhaseReviewService pending review cleanup', () => {
  let service: PhaseReviewService;
  let challengeApiService: {
    getChallengeById: jest.Mock;
  };
  let reviewService: {
    getActiveContestSubmissions: jest.Mock;
    getContestSubmissionsForLatestSelection: jest.Mock;
    getActiveCheckpointSubmissions: jest.Mock;
    getCheckpointPassedSubmissionIds: jest.Mock;
    getExistingReviewPairs: jest.Mock;
    createPendingReview: jest.Mock;
    deleteStalePendingSubmissionReviews: jest.Mock;
    deletePendingReviewsExceptSubmissions: jest.Mock;
    getFailedScreeningSubmissionIds: jest.Mock;
    getAiFailedDecisionSubmissionIds: jest.Mock;
    markSubmissionsAsAiFailedReview: jest.Mock;
    generateReviewSummaries: jest.Mock;
  };
  let resourcesService: {
    getReviewerResources: jest.Mock;
    ensureResourcesForMembers: jest.Mock;
  };

  beforeEach(() => {
    challengeApiService = {
      getChallengeById:
        createMockMethod<ChallengeApiService['getChallengeById']>(),
    };

    reviewService = {
      getActiveContestSubmissions:
        createMockMethod<ReviewService['getActiveContestSubmissions']>(),
      getContestSubmissionsForLatestSelection:
        createMockMethod<
          ReviewService['getContestSubmissionsForLatestSelection']
        >(),
      getActiveCheckpointSubmissions:
        createMockMethod<ReviewService['getActiveCheckpointSubmissions']>(),
      getCheckpointPassedSubmissionIds:
        createMockMethod<ReviewService['getCheckpointPassedSubmissionIds']>(),
      getExistingReviewPairs:
        createMockMethod<ReviewService['getExistingReviewPairs']>(),
      createPendingReview:
        createMockMethod<ReviewService['createPendingReview']>(),
      deleteStalePendingSubmissionReviews:
        createMockMethod<
          ReviewService['deleteStalePendingSubmissionReviews']
        >(),
      deletePendingReviewsExceptSubmissions:
        createMockMethod<
          ReviewService['deletePendingReviewsExceptSubmissions']
        >(),
      getFailedScreeningSubmissionIds:
        createMockMethod<ReviewService['getFailedScreeningSubmissionIds']>(),
      getAiFailedDecisionSubmissionIds:
        createMockMethod<ReviewService['getAiFailedDecisionSubmissionIds']>(),
      markSubmissionsAsAiFailedReview:
        createMockMethod<ReviewService['markSubmissionsAsAiFailedReview']>(),
      generateReviewSummaries:
        createMockMethod<ReviewService['generateReviewSummaries']>(),
    };

    resourcesService = {
      getReviewerResources:
        createMockMethod<ResourcesService['getReviewerResources']>(),
      ensureResourcesForMembers:
        createMockMethod<ResourcesService['ensureResourcesForMembers']>(),
    };

    reviewService.getExistingReviewPairs.mockResolvedValue(new Set());
    reviewService.createPendingReview.mockResolvedValue({
      created: true,
      reviewId: 'review-1',
    });
    reviewService.deleteStalePendingSubmissionReviews.mockResolvedValue(0);
    reviewService.deletePendingReviewsExceptSubmissions.mockResolvedValue(1);
    reviewService.getFailedScreeningSubmissionIds.mockResolvedValue(new Set());
    reviewService.getAiFailedDecisionSubmissionIds.mockResolvedValue(new Set());
    reviewService.markSubmissionsAsAiFailedReview.mockResolvedValue(0);
    reviewService.generateReviewSummaries.mockResolvedValue([]);
    resourcesService.getReviewerResources.mockResolvedValue([
      {
        id: 'resource-1',
        memberId: '123',
        memberHandle: 'reviewer',
        roleName: 'Reviewer',
      },
    ] satisfies ReviewerResourceRecord[]);
    resourcesService.ensureResourcesForMembers.mockResolvedValue([]);

    service = new PhaseReviewService(
      challengeApiService as unknown as ChallengeApiService,
      reviewService as unknown as ReviewService,
      resourcesService as unknown as ResourcesService,
      { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
      {
        handleReviewPhaseOpened: jest.fn(),
      } as unknown as MarathonMatchReviewService,
      {
        finalizeChallenge: jest.fn().mockResolvedValue(true),
      } as unknown as ChallengeCompletionService,
      {
        finalizeSummations: jest.fn().mockResolvedValue(undefined),
      } as unknown as ReviewSummationApiService,
      {
        logAction: jest.fn(),
      } as unknown as AutopilotDbLoggerService,
    );
  });

  it('prunes stale pending reviews for limited standard review phases', async () => {
    const challenge = buildChallenge(baseReviewPhase);
    const submissions: ActiveContestSubmission[] = [
      { id: 'old-submission', memberId: 'member-1', isLatest: false },
      { id: 'latest-submission', memberId: 'member-1', isLatest: true },
    ];

    challengeApiService.getChallengeById.mockResolvedValue(challenge);
    reviewService.getContestSubmissionsForLatestSelection.mockResolvedValue(
      submissions,
    );

    await service.handlePhaseOpened(challenge.id, baseReviewPhase.id);

    expect(
      reviewService.deletePendingReviewsExceptSubmissions.mock.calls,
    ).toEqual([[challenge.id, baseReviewPhase.id, ['latest-submission']]]);
    expect(reviewService.createPendingReview.mock.calls).toEqual([
      [
        'latest-submission',
        'resource-1',
        baseReviewPhase.id,
        'scorecard-1',
        challenge.id,
      ],
    ]);
  });

  it('keeps all active submissions when the challenge allows unlimited submissions', async () => {
    const challenge = buildChallenge(baseReviewPhase, undefined, {
      submissionLimit: JSON.stringify({
        unlimited: 'true',
        limit: 'false',
        count: '',
      }),
    });
    const submissions: ActiveContestSubmission[] = [
      { id: 'first-submission', memberId: 'member-1', isLatest: false },
      { id: 'second-submission', memberId: 'member-1', isLatest: true },
    ];

    challengeApiService.getChallengeById.mockResolvedValue(challenge);
    reviewService.getContestSubmissionsForLatestSelection.mockResolvedValue(
      submissions,
    );

    await service.handlePhaseOpened(challenge.id, baseReviewPhase.id);

    expect(
      reviewService.deletePendingReviewsExceptSubmissions.mock.calls,
    ).toEqual([
      [
        challenge.id,
        baseReviewPhase.id,
        ['first-submission', 'second-submission'],
      ],
    ]);
    const createdSubmissionIds =
      reviewService.createPendingReview.mock.calls.map(
        (call: [string, ...unknown[]]) => call[0],
      );

    expect(createdSubmissionIds).toEqual([
      'first-submission',
      'second-submission',
    ]);
  });

  it('prunes stale pending reviews for checkpoint review phases', async () => {
    const checkpointReviewPhase: IPhase = {
      ...baseReviewPhase,
      id: 'checkpoint-review-phase',
      phaseId: 'checkpoint-review-template',
      name: 'Checkpoint Review',
    };
    const checkpointScreeningPhase: IPhase = {
      ...baseReviewPhase,
      id: 'checkpoint-screening-phase',
      phaseId: 'checkpoint-screening-template',
      name: 'Checkpoint Screening',
    };
    const challenge = buildChallenge(
      checkpointReviewPhase,
      [
        {
          id: 'checkpoint-review-config',
          scorecardId: 'checkpoint-review-scorecard',
          isMemberReview: true,
          memberReviewerCount: 1,
          phaseId: checkpointReviewPhase.phaseId,
          fixedAmount: 0,
          baseCoefficient: null,
          incrementalCoefficient: null,
          type: null,
          aiWorkflowId: null,
          shouldOpenOpportunity: true,
        },
        {
          id: 'checkpoint-screening-config',
          scorecardId: 'checkpoint-screening-scorecard',
          isMemberReview: false,
          memberReviewerCount: 1,
          phaseId: checkpointScreeningPhase.phaseId,
          fixedAmount: 0,
          baseCoefficient: null,
          incrementalCoefficient: null,
          type: null,
          aiWorkflowId: null,
          shouldOpenOpportunity: true,
        },
      ],
      {},
      [checkpointReviewPhase, checkpointScreeningPhase],
    );

    const checkpointSubmissions: ActiveContestSubmission[] = [
      { id: 'old-checkpoint', memberId: 'member-1', isLatest: false },
      { id: 'latest-checkpoint', memberId: 'member-1', isLatest: true },
    ];

    resourcesService.getReviewerResources.mockResolvedValueOnce([
      {
        id: 'checkpoint-reviewer',
        memberId: '123',
        memberHandle: 'checkpoint-reviewer',
        roleName: 'Checkpoint Reviewer',
      },
    ] satisfies ReviewerResourceRecord[]);
    challengeApiService.getChallengeById.mockResolvedValue(challenge);
    reviewService.getActiveCheckpointSubmissions.mockResolvedValue(
      checkpointSubmissions,
    );
    reviewService.getCheckpointPassedSubmissionIds.mockResolvedValue([
      'old-checkpoint',
      'latest-checkpoint',
    ]);

    await service.handlePhaseOpened(challenge.id, checkpointReviewPhase.id);

    expect(
      reviewService.deletePendingReviewsExceptSubmissions.mock.calls,
    ).toEqual([
      [challenge.id, checkpointReviewPhase.id, ['latest-checkpoint']],
    ]);
    expect(reviewService.createPendingReview.mock.calls).toEqual([
      [
        'latest-checkpoint',
        'checkpoint-reviewer',
        checkpointReviewPhase.id,
        'checkpoint-review-scorecard',
        challenge.id,
      ],
    ]);
  });
});
