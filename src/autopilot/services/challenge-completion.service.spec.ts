import { ChallengeCompletionService } from './challenge-completion.service';
import { ChallengeStatusEnum, PrizeSetTypeEnum } from '@prisma/client';
import type { ChallengeApiService } from '../../challenge/challenge-api.service';
import type { ReviewService, SubmissionSummary } from '../../review/review.service';
import type { ResourcesService } from '../../resources/resources.service';
import type { FinanceApiService } from '../../finance/finance-api.service';
import type {
  IChallenge,
  IChallengePrizeSet,
} from '../../challenge/interfaces/challenge.interface';
import type { ConfigService } from '@nestjs/config';

describe('ChallengeCompletionService', () => {
  let challengeApiService: {
    getChallengeById: jest.MockedFunction<ChallengeApiService['getChallengeById']>;
    cancelChallenge: jest.MockedFunction<ChallengeApiService['cancelChallenge']>;
    completeChallenge: jest.MockedFunction<ChallengeApiService['completeChallenge']>;
    createPostMortemPhasePreserving: jest.MockedFunction<ChallengeApiService['createPostMortemPhasePreserving']>;
  };
  let reviewService: {
    generateReviewSummaries: jest.MockedFunction<ReviewService['generateReviewSummaries']>;
    getScorecardIdByName: jest.MockedFunction<ReviewService['getScorecardIdByName']>;
    createPendingReview: jest.MockedFunction<ReviewService['createPendingReview']>;
  };
  let resourcesService: {
    getMemberHandleMap: jest.MockedFunction<ResourcesService['getMemberHandleMap']>;
    getResourcesByRoleNames: jest.MockedFunction<ResourcesService['getResourcesByRoleNames']>;
  };
  let financeApiService: {
    generateChallengePayments: jest.MockedFunction<FinanceApiService['generateChallengePayments']>;
  };
  let configService: {
    get: jest.MockedFunction<ConfigService['get']>;
  };
  let service: ChallengeCompletionService;

  const baseTimestamp = '2024-01-01T00:00:00.000Z';

  const buildChallenge = (overrides: Partial<IChallenge>): IChallenge => ({
    id: 'challenge-1',
    name: 'Sample Challenge',
    description: null,
    descriptionFormat: 'markdown',
    projectId: 123,
    typeId: 'type-1',
    trackId: 'track-1',
    timelineTemplateId: 'timeline-1',
    currentPhaseNames: [],
    tags: [],
    groups: [],
    submissionStartDate: baseTimestamp,
    submissionEndDate: baseTimestamp,
    registrationStartDate: baseTimestamp,
    registrationEndDate: baseTimestamp,
    startDate: baseTimestamp,
    endDate: null,
    legacyId: null,
    status: ChallengeStatusEnum.ACTIVE,
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
    track: 'track',
    type: 'type',
    legacy: {},
    task: { isTask: false, isAssigned: false, memberId: null },
    created: baseTimestamp,
    updated: baseTimestamp,
    overview: { totalPrizes: 0 },
    numOfSubmissions: 0,
    numOfCheckpointSubmissions: 0,
    numOfRegistrants: 0,
    ...overrides,
  });

  const buildPlacementPrizeSet = (count: number): IChallengePrizeSet => ({
    type: PrizeSetTypeEnum.PLACEMENT,
    description: null,
    prizes: Array.from({ length: count }, (_, index) => ({
      type: 'USD',
      value: 100 - index * 10,
      description: null,
    })),
  });

  const summaries: SubmissionSummary[] = [
    {
      submissionId: 'sub-1',
      legacySubmissionId: null,
      memberId: '101',
      submittedDate: new Date('2024-01-02T10:00:00.000Z'),
      aggregateScore: 95,
      scorecardId: null,
      scorecardLegacyId: null,
      passingScore: 75,
      isPassing: true,
    },
    {
      submissionId: 'sub-2',
      legacySubmissionId: null,
      memberId: '102',
      submittedDate: new Date('2024-01-02T09:00:00.000Z'),
      aggregateScore: 92,
      scorecardId: null,
      scorecardLegacyId: null,
      passingScore: 75,
      isPassing: true,
    },
    {
      submissionId: 'sub-3',
      legacySubmissionId: null,
      memberId: '103',
      submittedDate: new Date('2024-01-02T11:00:00.000Z'),
      aggregateScore: 88,
      scorecardId: null,
      scorecardLegacyId: null,
      passingScore: 75,
      isPassing: true,
    },
  ];

  beforeEach(() => {
    challengeApiService = {
      getChallengeById: jest.fn(),
      cancelChallenge: jest.fn().mockResolvedValue(undefined),
      completeChallenge: jest.fn().mockResolvedValue(undefined),
      createPostMortemPhasePreserving: jest
        .fn()
        .mockResolvedValue({
          id: 'post-mortem-phase-id',
          phaseId: 'post-mortem-template',
          name: 'Post-Mortem',
          description: null,
          isOpen: true,
          duration: 0,
          scheduledStartDate: baseTimestamp,
          scheduledEndDate: baseTimestamp,
          actualStartDate: baseTimestamp,
          actualEndDate: null,
          predecessor: null,
          constraints: [],
        }),
    };

    reviewService = {
      generateReviewSummaries: jest.fn().mockResolvedValue(summaries),
      getScorecardIdByName: jest.fn().mockResolvedValue(null),
      createPendingReview: jest.fn().mockResolvedValue(true),
    };

    resourcesService = {
      getMemberHandleMap: jest
        .fn()
        .mockResolvedValue(
          new Map([
            ['101', 'user101'],
            ['102', 'user102'],
            ['103', 'user103'],
          ]),
        ),
      getResourcesByRoleNames: jest.fn().mockResolvedValue([]),
    };

    financeApiService = {
      generateChallengePayments: jest.fn().mockResolvedValue(true),
    } as unknown as {
      generateChallengePayments: jest.MockedFunction<FinanceApiService['generateChallengePayments']>;
    };

    configService = {
      get: jest.fn().mockReturnValue(null),
    };

    service = new ChallengeCompletionService(
      challengeApiService as unknown as ChallengeApiService,
      reviewService as unknown as ReviewService,
      resourcesService as unknown as ResourcesService,
      financeApiService as unknown as FinanceApiService,
      configService as unknown as ConfigService,
    );
  });

  it('limits winners to the number of placement prizes', async () => {
    const challenge = buildChallenge({
      prizeSets: [
        buildPlacementPrizeSet(2),
        {
          type: PrizeSetTypeEnum.COPILOT,
          description: null,
          prizes: [],
        },
      ],
      numOfSubmissions: 3,
    });

    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    const result = await service.finalizeChallenge(challenge.id);

    expect(result).toBe(true);
    expect(challengeApiService.completeChallenge).toHaveBeenCalledTimes(1);
    expect(financeApiService.generateChallengePayments).toHaveBeenCalledWith(
      challenge.id,
    );

    const [, winners] = challengeApiService.completeChallenge.mock.calls[0];
    expect(winners).toHaveLength(2);
    expect(winners[0]).toMatchObject({
      userId: 101,
      placement: 1,
      handle: 'user101',
    });
    expect(winners[1]).toMatchObject({
      userId: 102,
      placement: 2,
      handle: 'user102',
    });
  });

  it('falls back to all passing submissions when no placement prizes exist', async () => {
    const challenge = buildChallenge({
      prizeSets: [],
      numOfSubmissions: 3,
    });

    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    const result = await service.finalizeChallenge(challenge.id);

    expect(result).toBe(true);
    expect(challengeApiService.completeChallenge).toHaveBeenCalledTimes(1);
    expect(financeApiService.generateChallengePayments).toHaveBeenCalledWith(
      challenge.id,
    );

    const [, winners] = challengeApiService.completeChallenge.mock.calls[0];
    expect(winners).toHaveLength(summaries.length);
    expect(winners.map((winner) => winner.userId)).toEqual([101, 102, 103]);
  });

  it('creates post-mortem reviews for copilots when zero submissions trigger cancellation', async () => {
    const challenge = buildChallenge({
      numOfSubmissions: 0,
      phases: [
        {
          id: 'submission-phase-id',
          phaseId: 'submission-template',
          name: 'Submission',
          description: null,
          isOpen: false,
          duration: 0,
          scheduledStartDate: baseTimestamp,
          scheduledEndDate: baseTimestamp,
          actualStartDate: baseTimestamp,
          actualEndDate: baseTimestamp,
          predecessor: null,
          constraints: [],
        },
      ],
    });

    const postMortemPhase = {
      id: 'post-mortem-phase-id',
      phaseId: 'post-mortem-template',
      name: 'Post-Mortem',
      description: null,
      isOpen: true,
      duration: 0,
      scheduledStartDate: baseTimestamp,
      scheduledEndDate: baseTimestamp,
      actualStartDate: baseTimestamp,
      actualEndDate: null,
      predecessor: 'submission-template',
      constraints: [],
    };

    challengeApiService.getChallengeById.mockResolvedValue(challenge);
    challengeApiService.createPostMortemPhasePreserving.mockResolvedValueOnce(
      postMortemPhase,
    );

    reviewService.generateReviewSummaries.mockResolvedValueOnce([]);
    reviewService.getScorecardIdByName.mockResolvedValueOnce('scorecard-id');

    resourcesService.getResourcesByRoleNames.mockResolvedValueOnce([
      {
        id: 'copilot-resource-1',
        memberId: '201',
        memberHandle: 'copilot1',
        roleName: 'Copilot',
      },
      {
        id: 'copilot-resource-2',
        memberId: '202',
        memberHandle: 'copilot2',
        roleName: 'Copilot',
      },
    ]);

    const result = await service.finalizeChallenge(challenge.id);

    expect(result).toBe(true);
    expect(challengeApiService.cancelChallenge).toHaveBeenCalledWith(
      challenge.id,
      ChallengeStatusEnum.CANCELLED_ZERO_SUBMISSIONS,
    );
    expect(challengeApiService.createPostMortemPhasePreserving).toHaveBeenCalledWith(
      challenge.id,
      'submission-phase-id',
      expect.any(Number),
      true,
    );
    expect(reviewService.createPendingReview).toHaveBeenCalledTimes(2);
    expect(reviewService.createPendingReview).toHaveBeenCalledWith(
      null,
      'copilot-resource-1',
      postMortemPhase.id,
      'scorecard-id',
      challenge.id,
    );
    expect(reviewService.createPendingReview).toHaveBeenCalledWith(
      null,
      'copilot-resource-2',
      postMortemPhase.id,
      'scorecard-id',
      challenge.id,
    );
  });

  it('triggers finance payments on CANCELLED_FAILED_REVIEW', async () => {
    const challenge = buildChallenge({
      prizeSets: [buildPlacementPrizeSet(2)],
      numOfSubmissions: 2,
    });

    // All summaries are failing
    const failingSummaries = summaries.map((s) => ({
      ...s,
      isPassing: false as const,
    }));
    reviewService.generateReviewSummaries.mockResolvedValueOnce(
      failingSummaries,
    );
    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    const result = await service.finalizeChallenge(challenge.id);

    expect(result).toBe(true);
    expect(challengeApiService.cancelChallenge).toHaveBeenCalledWith(
      challenge.id,
      ChallengeStatusEnum.CANCELLED_FAILED_REVIEW,
    );
    expect(financeApiService.generateChallengePayments).toHaveBeenCalledWith(
      challenge.id,
    );
  });
});
