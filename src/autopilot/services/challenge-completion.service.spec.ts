import { ChallengeCompletionService } from './challenge-completion.service';
import { ChallengeStatusEnum, PrizeSetTypeEnum } from '@prisma/client';
import type { ChallengeApiService } from '../../challenge/challenge-api.service';
import type {
  ReviewService,
  SubmissionSummary,
} from '../../review/review.service';
import type { ResourcesService } from '../../resources/resources.service';
import type { FinanceApiService } from '../../finance/finance-api.service';
import type { MemberApiService } from '../../member-api/member-api.service';
import type { KafkaService } from '../../kafka/kafka.service';
import { KAFKA_TOPICS } from '../../kafka/constants/topics';
import { POST_MORTEM_REVIEWER_ROLE_NAME } from '../constants/review.constants';
import type {
  IChallenge,
  IChallengePrizeSet,
} from '../../challenge/interfaces/challenge.interface';
import type { ConfigService } from '@nestjs/config';
import type { ReviewSummationApiService } from './review-summation-api.service';
import type { MarathonMatchApiService } from '../../marathon-match/marathon-match-api.service';

describe('ChallengeCompletionService', () => {
  let challengeApiService: {
    getChallengeById: jest.MockedFunction<
      ChallengeApiService['getChallengeById']
    >;
    cancelChallenge: jest.MockedFunction<
      ChallengeApiService['cancelChallenge']
    >;
    completeChallenge: jest.MockedFunction<
      ChallengeApiService['completeChallenge']
    >;
    createPostMortemPhasePreserving: jest.MockedFunction<
      ChallengeApiService['createPostMortemPhasePreserving']
    >;
    setCheckpointWinners: jest.MockedFunction<
      ChallengeApiService['setCheckpointWinners']
    >;
  };
  let reviewService: {
    generateReviewSummaries: jest.MockedFunction<
      ReviewService['generateReviewSummaries']
    >;
    getScorecardIdByName: jest.MockedFunction<
      ReviewService['getScorecardIdByName']
    >;
    createPendingReview: jest.MockedFunction<
      ReviewService['createPendingReview']
    >;
    getTopCheckpointReviewScores: jest.MockedFunction<
      ReviewService['getTopCheckpointReviewScores']
    >;
  };
  let resourcesService: {
    getMemberHandleMap: jest.MockedFunction<
      ResourcesService['getMemberHandleMap']
    >;
    getResourcesByRoleNames: jest.MockedFunction<
      ResourcesService['getResourcesByRoleNames']
    >;
    ensureResourcesForMembers: jest.MockedFunction<
      ResourcesService['ensureResourcesForMembers']
    >;
  };
  let financeApiService: {
    generateChallengePayments: jest.MockedFunction<
      FinanceApiService['generateChallengePayments']
    >;
  };
  let memberApiService: {
    refreshMemberStats: jest.MockedFunction<
      MemberApiService['refreshMemberStats']
    >;
    rerateMemberStats: jest.MockedFunction<
      MemberApiService['rerateMemberStats']
    >;
  };
  let kafkaService: {
    produce: jest.MockedFunction<KafkaService['produce']>;
  };
  let configService: {
    get: jest.MockedFunction<ConfigService['get']>;
  };
  let reviewSummationApiService: jest.Mocked<ReviewSummationApiService>;
  let finalizeSummationsMock: jest.MockedFunction<
    ReviewSummationApiService['finalizeSummations']
  >;
  let marathonMatchApiService: {
    getConfig: jest.MockedFunction<MarathonMatchApiService['getConfig']>;
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
    track: 'Development',
    type: 'Challenge',
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

  it('assigns checkpoint winners using top checkpoint review scores', async () => {
    const challenge = buildChallenge({
      prizeSets: [buildCheckpointPrizeSet(3)],
    });
    challengeApiService.getChallengeById.mockResolvedValue(challenge);
    reviewService.getTopCheckpointReviewScores.mockResolvedValue([
      { memberId: '101', submissionId: 'sub-1', score: 95 },
      { memberId: '102', submissionId: 'sub-2', score: 90 },
      { memberId: '103', submissionId: 'sub-3', score: 85 },
    ]);

    await service.assignCheckpointWinners(
      challenge.id,
      'phase-checkpoint-review',
    );

    expect(challengeApiService.setCheckpointWinners).toHaveBeenCalledTimes(1);
    expect(challengeApiService.setCheckpointWinners).toHaveBeenCalledWith(
      challenge.id,
      [
        {
          userId: 101,
          handle: 'user101',
          placement: 1,
          type: PrizeSetTypeEnum.CHECKPOINT,
        },
        {
          userId: 102,
          handle: 'user102',
          placement: 2,
          type: PrizeSetTypeEnum.CHECKPOINT,
        },
        {
          userId: 103,
          handle: 'user103',
          placement: 3,
          type: PrizeSetTypeEnum.CHECKPOINT,
        },
      ],
    );
  });

  it('limits checkpoint winners to the number of checkpoint prizes', async () => {
    const challenge = buildChallenge({
      prizeSets: [buildCheckpointPrizeSet(2)],
    });
    challengeApiService.getChallengeById.mockResolvedValue(challenge);
    reviewService.getTopCheckpointReviewScores.mockResolvedValue([
      { memberId: '101', submissionId: 'sub-1', score: 99 },
      { memberId: '102', submissionId: 'sub-2', score: 95 },
      { memberId: '103', submissionId: 'sub-3', score: 90 },
    ]);

    await service.assignCheckpointWinners(
      challenge.id,
      'phase-checkpoint-review',
    );

    expect(challengeApiService.setCheckpointWinners).toHaveBeenCalledTimes(1);
    expect(challengeApiService.setCheckpointWinners.mock.calls[0][1]).toEqual([
      {
        userId: 101,
        handle: 'user101',
        placement: 1,
        type: PrizeSetTypeEnum.CHECKPOINT,
      },
      {
        userId: 102,
        handle: 'user102',
        placement: 2,
        type: PrizeSetTypeEnum.CHECKPOINT,
      },
    ]);
  });

  it('clears checkpoint winners when no checkpoint prizes are defined', async () => {
    const challenge = buildChallenge({
      prizeSets: [],
    });
    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    await service.assignCheckpointWinners(
      challenge.id,
      'phase-checkpoint-review',
    );

    expect(challengeApiService.setCheckpointWinners).toHaveBeenCalledWith(
      challenge.id,
      [],
    );
  });

  it('clears checkpoint winners when no checkpoint review scores are available', async () => {
    const challenge = buildChallenge({
      prizeSets: [buildCheckpointPrizeSet(2)],
    });
    challengeApiService.getChallengeById.mockResolvedValue(challenge);
    reviewService.getTopCheckpointReviewScores.mockResolvedValue([]);

    await service.assignCheckpointWinners(
      challenge.id,
      'phase-checkpoint-review',
    );

    expect(challengeApiService.setCheckpointWinners).toHaveBeenCalledWith(
      challenge.id,
      [],
    );
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

  const buildCheckpointPrizeSet = (count: number): IChallengePrizeSet => ({
    type: PrizeSetTypeEnum.CHECKPOINT,
    description: 'Checkpoint Prizes',
    prizes: Array.from({ length: count }, () => ({
      type: 'USD',
      value: 100,
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
      createPostMortemPhasePreserving: jest.fn().mockResolvedValue({
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
      setCheckpointWinners: jest.fn().mockResolvedValue(undefined),
    };

    reviewService = {
      generateReviewSummaries: jest.fn().mockResolvedValue(summaries),
      getScorecardIdByName: jest.fn().mockResolvedValue(null),
      createPendingReview: jest.fn().mockResolvedValue(true),
      getTopCheckpointReviewScores: jest.fn().mockResolvedValue([]),
    };

    resourcesService = {
      getMemberHandleMap: jest.fn().mockResolvedValue(
        new Map([
          ['101', 'user101'],
          ['102', 'user102'],
          ['103', 'user103'],
        ]),
      ),
      getResourcesByRoleNames: jest.fn().mockResolvedValue([]),
      ensureResourcesForMembers: jest.fn().mockResolvedValue([]),
    };

    financeApiService = {
      generateChallengePayments: jest.fn().mockResolvedValue(true),
    } as unknown as {
      generateChallengePayments: jest.MockedFunction<
        FinanceApiService['generateChallengePayments']
      >;
    };

    memberApiService = {
      refreshMemberStats: jest.fn().mockResolvedValue(true),
      rerateMemberStats: jest.fn().mockResolvedValue(true),
    } as unknown as {
      refreshMemberStats: jest.MockedFunction<
        MemberApiService['refreshMemberStats']
      >;
      rerateMemberStats: jest.MockedFunction<
        MemberApiService['rerateMemberStats']
      >;
    };

    kafkaService = {
      produce: jest.fn().mockResolvedValue(undefined),
    };

    configService = {
      get: jest.fn().mockReturnValue(null),
    };

    finalizeSummationsMock = jest
      .fn()
      .mockResolvedValue(true) as jest.MockedFunction<
      ReviewSummationApiService['finalizeSummations']
    >;
    reviewSummationApiService = {
      finalizeSummations: finalizeSummationsMock,
    } as unknown as jest.Mocked<ReviewSummationApiService>;

    marathonMatchApiService = {
      getConfig: jest.fn().mockResolvedValue(null),
    };

    service = new ChallengeCompletionService(
      challengeApiService as unknown as ChallengeApiService,
      reviewService as unknown as ReviewService,
      resourcesService as unknown as ResourcesService,
      financeApiService as unknown as FinanceApiService,
      memberApiService as unknown as MemberApiService,
      reviewSummationApiService as unknown as ReviewSummationApiService,
      configService as unknown as ConfigService,
      kafkaService as unknown as KafkaService,
      marathonMatchApiService as unknown as MarathonMatchApiService,
    );
  });

  it('replays finance and member stats when challenge is already COMPLETED', async () => {
    const challenge = buildChallenge({
      status: ChallengeStatusEnum.COMPLETED,
      trackId: '11111111-1111-1111-1111-111111111111',
      typeId: '22222222-2222-2222-2222-222222222222',
      metadata: { rated: 'true' },
      winners: [
        {
          userId: 101,
          handle: 'user101',
          placement: 1,
          type: PrizeSetTypeEnum.PLACEMENT,
        },
      ],
      prizeSets: [buildPlacementPrizeSet(1)],
    });

    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    const result = await service.finalizeChallenge(challenge.id);

    expect(result).toBe(true);
    expect(finalizeSummationsMock.mock.calls).toHaveLength(0);
    expect(challengeApiService.completeChallenge).not.toHaveBeenCalled();
    expect(financeApiService.generateChallengePayments).toHaveBeenCalledWith(
      challenge.id,
    );
    expect(memberApiService.refreshMemberStats).toHaveBeenCalledTimes(1);
    expect(memberApiService.refreshMemberStats).toHaveBeenCalledWith(
      'user101',
      challenge.id,
    );
    expect(memberApiService.rerateMemberStats).toHaveBeenCalledTimes(1);
    expect(memberApiService.rerateMemberStats).toHaveBeenCalledWith(
      'user101',
      challenge.id,
      'DEVELOP',
      'Challenge',
    );
  });

  it('stores remaining passing submissions as passed review winners', async () => {
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
    expect(finalizeSummationsMock.mock.calls).toHaveLength(1);
    expect(finalizeSummationsMock.mock.calls[0]).toEqual([challenge.id]);
    expect(challengeApiService.completeChallenge).toHaveBeenCalledTimes(1);
    expect(financeApiService.generateChallengePayments).toHaveBeenCalledWith(
      challenge.id,
    );
    const produceCall = kafkaService.produce.mock.calls[0];
    expect(produceCall[0]).toBe(KAFKA_TOPICS.CHALLENGE_UPDATED);
    const producedMessage = produceCall[1] as {
      topic: string;
      payload: {
        id: string;
        status: ChallengeStatusEnum;
        winners: Array<{ userId: number; placement: number }>;
      };
    };
    expect(producedMessage.topic).toBe(KAFKA_TOPICS.CHALLENGE_UPDATED);
    expect(producedMessage.payload.id).toBe(challenge.id);
    expect(producedMessage.payload.status).toBe(ChallengeStatusEnum.COMPLETED);
    expect(producedMessage.payload.winners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 101, placement: 1 }),
        expect.objectContaining({ userId: 102, placement: 2 }),
      ]),
    );

    const completeChallengeCall =
      challengeApiService.completeChallenge.mock.calls[0];
    const winners = completeChallengeCall[1];
    expect(winners).toHaveLength(3);
    expect(winners[0]).toMatchObject({
      userId: 101,
      placement: 1,
      handle: 'user101',
      type: PrizeSetTypeEnum.PLACEMENT,
    });
    expect(winners[1]).toMatchObject({
      userId: 102,
      placement: 2,
      handle: 'user102',
      type: PrizeSetTypeEnum.PLACEMENT,
    });
    expect(winners[2]).toMatchObject({
      userId: 103,
      placement: 1,
      handle: 'user103',
      type: PrizeSetTypeEnum.PASSED_REVIEW,
    });
  });

  it('preserves multiple passing submissions from the same member', async () => {
    const challenge = buildChallenge({
      prizeSets: [buildPlacementPrizeSet(3)],
      numOfSubmissions: 3,
      trackId: '33333333-3333-3333-3333-333333333333',
      typeId: '44444444-4444-4444-4444-444444444444',
      metadata: { rated: 'true' },
    });

    const duplicateSummaries: SubmissionSummary[] = [
      {
        submissionId: 'sub-1',
        legacySubmissionId: null,
        memberId: '101',
        submittedDate: new Date('2024-01-02T08:00:00.000Z'),
        aggregateScore: 98,
        scorecardId: null,
        scorecardLegacyId: null,
        passingScore: 75,
        isPassing: true,
      },
      {
        submissionId: 'sub-2',
        legacySubmissionId: null,
        memberId: '101',
        submittedDate: new Date('2024-01-02T09:00:00.000Z'),
        aggregateScore: 96,
        scorecardId: null,
        scorecardLegacyId: null,
        passingScore: 75,
        isPassing: true,
      },
      {
        submissionId: 'sub-3',
        legacySubmissionId: null,
        memberId: '102',
        submittedDate: new Date('2024-01-02T10:00:00.000Z'),
        aggregateScore: 94,
        scorecardId: null,
        scorecardLegacyId: null,
        passingScore: 75,
        isPassing: true,
      },
    ];

    reviewService.generateReviewSummaries.mockResolvedValueOnce(
      duplicateSummaries,
    );
    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    const result = await service.finalizeChallenge(challenge.id);

    expect(result).toBe(true);
    expect(finalizeSummationsMock.mock.calls).toHaveLength(1);
    expect(finalizeSummationsMock.mock.calls[0]).toEqual([challenge.id]);
    expect(challengeApiService.completeChallenge).toHaveBeenCalledTimes(1);
    const completeChallengeCall =
      challengeApiService.completeChallenge.mock.calls[0];
    const winners = completeChallengeCall[1];

    expect(winners).toHaveLength(3);
    expect(winners.map((winner) => winner.userId)).toEqual([101, 101, 102]);
    expect(winners.map((winner) => winner.placement)).toEqual([1, 2, 3]);
    expect(winners.map((winner) => winner.type)).toEqual([
      PrizeSetTypeEnum.PLACEMENT,
      PrizeSetTypeEnum.PLACEMENT,
      PrizeSetTypeEnum.PLACEMENT,
    ]);
    expect(financeApiService.generateChallengePayments).toHaveBeenCalledWith(
      challenge.id,
    );
    expect(memberApiService.refreshMemberStats).toHaveBeenCalledTimes(2);
    expect(memberApiService.refreshMemberStats).toHaveBeenCalledWith(
      'user101',
      challenge.id,
    );
    expect(memberApiService.refreshMemberStats).toHaveBeenCalledWith(
      'user102',
      challenge.id,
    );
    expect(memberApiService.rerateMemberStats).toHaveBeenCalledTimes(2);
    expect(memberApiService.rerateMemberStats).toHaveBeenCalledWith(
      'user101',
      challenge.id,
      'DEVELOP',
      'Challenge',
    );
    expect(memberApiService.rerateMemberStats).toHaveBeenCalledWith(
      'user102',
      challenge.id,
      'DEVELOP',
      'Challenge',
    );
  });

  it('skips rerate when metadata marks the challenge as unrated', async () => {
    const challenge = buildChallenge({
      prizeSets: [buildPlacementPrizeSet(2)],
      numOfSubmissions: 3,
      metadata: { unrated: true } as unknown as IChallenge['metadata'],
    });

    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    const result = await service.finalizeChallenge(challenge.id);

    expect(result).toBe(true);
    expect(memberApiService.refreshMemberStats).toHaveBeenCalledTimes(2);
    expect(memberApiService.rerateMemberStats).not.toHaveBeenCalled();
  });

  it('skips rerate when rating metadata is absent', async () => {
    const challenge = buildChallenge({
      prizeSets: [buildPlacementPrizeSet(2)],
      numOfSubmissions: 3,
      metadata: {},
    });

    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    const result = await service.finalizeChallenge(challenge.id);

    expect(result).toBe(true);
    expect(memberApiService.refreshMemberStats).toHaveBeenCalledTimes(2);
    expect(memberApiService.rerateMemberStats).not.toHaveBeenCalled();
  });

  it('falls back to all passing submissions when no placement prizes exist', async () => {
    const challenge = buildChallenge({
      prizeSets: [],
      numOfSubmissions: 3,
      metadata: { isRated: 'true' },
    });

    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    const result = await service.finalizeChallenge(challenge.id);

    expect(result).toBe(true);
    expect(finalizeSummationsMock.mock.calls).toHaveLength(1);
    expect(finalizeSummationsMock.mock.calls[0]).toEqual([challenge.id]);
    expect(challengeApiService.completeChallenge).toHaveBeenCalledTimes(1);
    expect(financeApiService.generateChallengePayments).toHaveBeenCalledWith(
      challenge.id,
    );

    const completeChallengeCall =
      challengeApiService.completeChallenge.mock.calls[0];
    const winners = completeChallengeCall[1];
    expect(winners).toHaveLength(summaries.length);
    expect(winners.map((winner) => winner.userId)).toEqual([101, 102, 103]);
    expect(winners.map((winner) => winner.type)).toEqual([
      PrizeSetTypeEnum.PLACEMENT,
      PrizeSetTypeEnum.PLACEMENT,
      PrizeSetTypeEnum.PLACEMENT,
    ]);
    expect(memberApiService.refreshMemberStats).toHaveBeenCalledTimes(3);
    expect(memberApiService.rerateMemberStats).toHaveBeenCalledTimes(3);
  });

  it('triggers member stats refresh and rerate after explicit winner completion', async () => {
    const challenge = buildChallenge({
      status: ChallengeStatusEnum.ACTIVE,
      numOfSubmissions: 2,
      track: 'Data Science',
      type: 'Marathon Match',
      trackId: '55555555-5555-5555-5555-555555555555',
      typeId: '66666666-6666-6666-6666-666666666666',
      metadata: { rated: 'true' },
    });
    const winners = [
      {
        userId: 101,
        handle: 'user101',
        placement: 1,
        type: PrizeSetTypeEnum.PLACEMENT,
      },
      {
        userId: 101,
        handle: 'user101',
        placement: 2,
        type: PrizeSetTypeEnum.PASSED_REVIEW,
      },
      {
        userId: 102,
        handle: 'user102',
        placement: 3,
        type: PrizeSetTypeEnum.PASSED_REVIEW,
      },
    ];

    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    await service.completeChallengeWithWinners(challenge.id, winners, {
      reason: 'manual completion',
    });
    await Promise.resolve();

    expect(financeApiService.generateChallengePayments).toHaveBeenCalledWith(
      challenge.id,
    );
    expect(memberApiService.refreshMemberStats).toHaveBeenCalledTimes(2);
    expect(memberApiService.refreshMemberStats).toHaveBeenCalledWith(
      'user101',
      challenge.id,
    );
    expect(memberApiService.refreshMemberStats).toHaveBeenCalledWith(
      'user102',
      challenge.id,
    );
    expect(memberApiService.rerateMemberStats).toHaveBeenCalledTimes(2);
    expect(memberApiService.rerateMemberStats).toHaveBeenCalledWith(
      'user101',
      challenge.id,
      'DATA_SCIENCE',
      'MARATHON_MATCH',
    );
    expect(memberApiService.rerateMemberStats).toHaveBeenCalledWith(
      'user102',
      challenge.id,
      'DATA_SCIENCE',
      'MARATHON_MATCH',
    );
  });

  it('skips rerate for normalized track and type pairs not supported by member-api', async () => {
    const challenge = buildChallenge({
      status: ChallengeStatusEnum.ACTIVE,
      numOfSubmissions: 2,
      track: 'Data Science',
      type: 'Challenge',
      metadata: { rated: 'true' },
    });

    const winners = [
      {
        userId: 101,
        handle: 'user101',
        placement: 1,
        type: PrizeSetTypeEnum.PLACEMENT,
      },
    ];

    challengeApiService.getChallengeById.mockResolvedValue(challenge);

    await service.completeChallengeWithWinners(challenge.id, winners, {
      reason: 'manual completion',
    });
    await Promise.resolve();

    expect(memberApiService.refreshMemberStats).toHaveBeenCalledWith(
      'user101',
      challenge.id,
    );
    expect(memberApiService.rerateMemberStats).not.toHaveBeenCalled();
  });

  it('creates post-mortem reviews for reviewers and copilots when zero submissions trigger cancellation', async () => {
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
        id: 'reviewer-resource-1',
        memberId: '301',
        memberHandle: 'reviewer1',
        roleName: 'Reviewer',
      },
      {
        id: 'reviewer-resource-2',
        memberId: '302',
        memberHandle: 'reviewer2',
        roleName: 'Reviewer',
      },
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
    resourcesService.ensureResourcesForMembers.mockResolvedValueOnce([
      {
        id: 'pm-resource-1',
        memberId: '301',
        memberHandle: 'reviewer1',
        roleName: POST_MORTEM_REVIEWER_ROLE_NAME,
      },
      {
        id: 'pm-resource-2',
        memberId: '302',
        memberHandle: 'reviewer2',
        roleName: POST_MORTEM_REVIEWER_ROLE_NAME,
      },
      {
        id: 'pm-resource-3',
        memberId: '201',
        memberHandle: 'copilot1',
        roleName: POST_MORTEM_REVIEWER_ROLE_NAME,
      },
      {
        id: 'pm-resource-4',
        memberId: '202',
        memberHandle: 'copilot2',
        roleName: POST_MORTEM_REVIEWER_ROLE_NAME,
      },
    ]);

    const result = await service.finalizeChallenge(challenge.id);

    expect(result).toBe(true);
    expect(finalizeSummationsMock.mock.calls).toHaveLength(1);
    expect(finalizeSummationsMock.mock.calls[0]).toEqual([challenge.id]);
    expect(challengeApiService.cancelChallenge).toHaveBeenCalledWith(
      challenge.id,
      ChallengeStatusEnum.CANCELLED_ZERO_SUBMISSIONS,
    );
    expect(
      challengeApiService.createPostMortemPhasePreserving,
    ).toHaveBeenCalledWith(
      challenge.id,
      'submission-phase-id',
      expect.any(Number),
      true,
    );
    expect(resourcesService.ensureResourcesForMembers).toHaveBeenCalledWith(
      challenge.id,
      [
        {
          id: 'reviewer-resource-1',
          memberId: '301',
          memberHandle: 'reviewer1',
          roleName: 'Reviewer',
        },
        {
          id: 'reviewer-resource-2',
          memberId: '302',
          memberHandle: 'reviewer2',
          roleName: 'Reviewer',
        },
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
      ],
      POST_MORTEM_REVIEWER_ROLE_NAME,
    );
    expect(reviewService.createPendingReview).toHaveBeenCalledTimes(4);
    expect(reviewService.createPendingReview).toHaveBeenCalledWith(
      null,
      'pm-resource-3',
      postMortemPhase.id,
      'scorecard-id',
      challenge.id,
    );
    expect(reviewService.createPendingReview).toHaveBeenCalledWith(
      null,
      'pm-resource-4',
      postMortemPhase.id,
      'scorecard-id',
      challenge.id,
    );
    expect(reviewService.createPendingReview).toHaveBeenCalledWith(
      null,
      'pm-resource-1',
      postMortemPhase.id,
      'scorecard-id',
      challenge.id,
    );
    expect(reviewService.createPendingReview).toHaveBeenCalledWith(
      null,
      'pm-resource-2',
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
    expect(finalizeSummationsMock.mock.calls).toHaveLength(1);
    expect(finalizeSummationsMock.mock.calls[0]).toEqual([challenge.id]);
    expect(challengeApiService.cancelChallenge).toHaveBeenCalledWith(
      challenge.id,
      ChallengeStatusEnum.CANCELLED_FAILED_REVIEW,
    );
    expect(financeApiService.generateChallengePayments).toHaveBeenCalledWith(
      challenge.id,
    );
  });
});
