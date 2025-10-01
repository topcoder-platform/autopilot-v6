import { ChallengeCompletionService } from './challenge-completion.service';
import { ChallengeStatusEnum, PrizeSetTypeEnum } from '@prisma/client';
import type { ChallengeApiService } from '../../challenge/challenge-api.service';
import type { ReviewService, SubmissionSummary } from '../../review/review.service';
import type { ResourcesService } from '../../resources/resources.service';
import type {
  IChallenge,
  IChallengePrizeSet,
} from '../../challenge/interfaces/challenge.interface';

describe('ChallengeCompletionService', () => {
  let challengeApiService: {
    getChallengeById: jest.MockedFunction<ChallengeApiService['getChallengeById']>;
    cancelChallenge: jest.MockedFunction<ChallengeApiService['cancelChallenge']>;
    completeChallenge: jest.MockedFunction<ChallengeApiService['completeChallenge']>;
  };
  let reviewService: {
    generateReviewSummaries: jest.MockedFunction<ReviewService['generateReviewSummaries']>;
  };
  let resourcesService: {
    getMemberHandleMap: jest.MockedFunction<ResourcesService['getMemberHandleMap']>;
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
    };

    reviewService = {
      generateReviewSummaries: jest.fn().mockResolvedValue(summaries),
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
    };

    service = new ChallengeCompletionService(
      challengeApiService as unknown as ChallengeApiService,
      reviewService as unknown as ReviewService,
      resourcesService as unknown as ResourcesService,
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

    const [, winners] = challengeApiService.completeChallenge.mock.calls[0];
    expect(winners).toHaveLength(summaries.length);
    expect(winners.map((winner) => winner.userId)).toEqual([101, 102, 103]);
  });
});
