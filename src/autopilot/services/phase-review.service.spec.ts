import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhaseReviewService } from './phase-review.service';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import type { IChallenge } from '../../challenge/interfaces/challenge.interface';
import { ReviewService, ActiveContestSubmission } from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';

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

const buildChallenge = (
  metadata: Record<string, string>,
): IChallenge => ({
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
      basePayment: null,
      incrementalPayment: null,
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
  let loggerSpy: jest.SpyInstance;
  let service: PhaseReviewService;
  let challengeApiService: jest.Mocked<ChallengeApiService>;
  let reviewService: jest.Mocked<ReviewService>;
  let resourcesService: jest.Mocked<ResourcesService>;
  let configService: jest.Mocked<ConfigService>;

  beforeAll(() => {
    loggerSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  beforeEach(() => {
    challengeApiService = {
      getChallengeById: jest.fn(),
    } as unknown as jest.Mocked<ChallengeApiService>;

    reviewService = {
      getActiveContestSubmissions: jest.fn(),
      getExistingReviewPairs: jest.fn(),
      createPendingReview: jest.fn(),
    } as unknown as jest.Mocked<ReviewService>;

    resourcesService = {
      getReviewerResources: jest.fn(),
      getResourcesByRoleNames: jest.fn(),
      getResourceById: jest.fn(),
      getRoleNameById: jest.fn(),
      hasSubmitterResource: jest.fn(),
      getMemberHandleMap: jest.fn(),
      getResourceByMemberHandle: jest.fn(),
    } as unknown as jest.Mocked<ResourcesService>;

    configService = {
      get: jest.fn(),
    } as unknown as jest.Mocked<ConfigService>;

    reviewService.getExistingReviewPairs.mockResolvedValue(new Set());
    resourcesService.getReviewerResources.mockResolvedValue([{ id: 'resource-1' }] as any);
    reviewService.createPendingReview.mockResolvedValue(true);

    service = new PhaseReviewService(
      challengeApiService,
      reviewService,
      resourcesService,
      configService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    loggerSpy?.mockRestore();
  });

  it('creates reviews only for latest submissions when no submission limit is set', async () => {
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
    expect(createdSubmissionIds).not.toContain('old-submission');
  });

  it('includes all submissions when the challenge enforces a submission limit', async () => {
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

    expect(createdSubmissionIds).toEqual([
      'old-submission',
      'latest-submission',
    ]);
  });
});
