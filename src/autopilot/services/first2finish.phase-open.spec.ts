import type { ConfigService } from '@nestjs/config';
import type { ChallengeApiService } from '../../challenge/challenge-api.service';
import type {
  IChallenge,
  IPhase,
} from '../../challenge/interfaces/challenge.interface';
import type { ReviewService } from '../../review/review.service';
import type { ResourcesService } from '../../resources/resources.service';
import type { ChallengeCompletionService } from './challenge-completion.service';
import type { SchedulerService } from './scheduler.service';
import { ITERATIVE_REVIEW_PHASE_NAME } from '../constants/review.constants';
import { First2FinishService } from './first2finish.service';

const createIterativePhase = (overrides: Partial<IPhase> = {}): IPhase => ({
  id: 'iterative-phase-1',
  phaseId: 'iterative-template',
  name: ITERATIVE_REVIEW_PHASE_NAME,
  description: null,
  isOpen: true,
  duration: 86400,
  scheduledStartDate: '2026-05-18T00:00:00.000Z',
  scheduledEndDate: '2026-05-19T00:00:00.000Z',
  actualStartDate: '2026-05-18T00:00:00.000Z',
  actualEndDate: null,
  predecessor: null,
  constraints: [],
  ...overrides,
});

const createChallenge = (phases: IPhase[]): IChallenge =>
  ({
    id: 'challenge-1',
    projectId: 1001,
    status: 'ACTIVE',
    type: 'Topgear Task',
    phases,
    reviewers: [
      {
        id: 'reviewer-config-1',
        phaseId: 'iterative-template',
        scorecardId: 'scorecard-1',
        isMemberReview: true,
        memberReviewerCount: 1,
        fixedAmount: null,
        baseCoefficient: null,
        incrementalCoefficient: null,
        type: null,
        aiWorkflowId: null,
        shouldOpenOpportunity: false,
      },
    ],
    legacy: {},
  }) as unknown as IChallenge;

describe('First2FinishService iterative phase-open repair', () => {
  let challengeApiService: {
    getChallengeById: jest.Mock<Promise<IChallenge>, [string]>;
    createIterativeReviewPhase: jest.Mock;
  };
  let schedulerService: {
    advancePhase: jest.Mock;
    schedulePhaseTransition: jest.Mock<
      Promise<string>,
      [Record<string, unknown>]
    >;
  };
  let reviewService: {
    getPendingReviewCount: jest.Mock<Promise<number>, [string, string]>;
    getExistingReviewPairs: jest.Mock<Promise<Set<string>>, [string, string]>;
    getReviewerSubmissionPairs: jest.Mock<Promise<Set<string>>, [string]>;
    getAllSubmissionIdsOrdered: jest.Mock<Promise<string[]>, [string]>;
    getAiFailedDecisionSubmissionIds: jest.Mock<
      Promise<Set<string>>,
      [string, string[]]
    >;
    createPendingReview: jest.Mock<
      Promise<{ created: boolean }>,
      [string, string, string, string, string]
    >;
  };
  let resourcesService: {
    getReviewerResources: jest.Mock<
      Promise<Array<{ id: string }>>,
      [string, string[]]
    >;
  };
  let service: First2FinishService;

  beforeEach(() => {
    jest.useFakeTimers();

    challengeApiService = {
      getChallengeById: jest.fn<Promise<IChallenge>, [string]>(),
      createIterativeReviewPhase: jest.fn(),
    };
    schedulerService = {
      advancePhase: jest.fn(),
      schedulePhaseTransition: jest
        .fn<Promise<string>, [Record<string, unknown>]>()
        .mockResolvedValue('job-id'),
    };
    reviewService = {
      getPendingReviewCount: jest
        .fn<Promise<number>, [string, string]>()
        .mockResolvedValue(0),
      getExistingReviewPairs: jest
        .fn<Promise<Set<string>>, [string, string]>()
        .mockResolvedValue(new Set<string>()),
      getReviewerSubmissionPairs: jest
        .fn<Promise<Set<string>>, [string]>()
        .mockResolvedValue(new Set<string>()),
      getAllSubmissionIdsOrdered: jest
        .fn<Promise<string[]>, [string]>()
        .mockResolvedValue(['submission-1']),
      getAiFailedDecisionSubmissionIds: jest
        .fn<Promise<Set<string>>, [string, string[]]>()
        .mockResolvedValue(new Set<string>()),
      createPendingReview: jest
        .fn<
          Promise<{ created: boolean }>,
          [string, string, string, string, string]
        >()
        .mockResolvedValue({ created: true }),
    };
    resourcesService = {
      getReviewerResources: jest
        .fn<Promise<Array<{ id: string }>>, [string, string[]]>()
        .mockResolvedValue([{ id: 'iterative-reviewer-resource' }]),
    };

    service = new First2FinishService(
      challengeApiService as unknown as ChallengeApiService,
      schedulerService as unknown as SchedulerService,
      reviewService as unknown as ReviewService,
      resourcesService as unknown as ResourcesService,
      { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
      {} as unknown as ChallengeCompletionService,
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('assigns a pending review on the opened latest iterative phase', async () => {
    const phase = createIterativePhase();
    challengeApiService.getChallengeById.mockResolvedValue(
      createChallenge([phase]),
    );

    await service.handleIterativePhaseOpened('challenge-1', phase.id);

    expect(reviewService.createPendingReview.mock.calls).toContainEqual([
      'submission-1',
      'iterative-reviewer-resource',
      phase.id,
      'scorecard-1',
      'challenge-1',
    ]);
    expect(schedulerService.schedulePhaseTransition.mock.calls).toHaveLength(1);
    expect(schedulerService.advancePhase.mock.calls).toHaveLength(0);
    expect(
      challengeApiService.createIterativeReviewPhase.mock.calls,
    ).toHaveLength(0);
  });

  it('leaves the phase open when there are no eligible submissions', async () => {
    const phase = createIterativePhase();
    challengeApiService.getChallengeById.mockResolvedValue(
      createChallenge([phase]),
    );
    reviewService.getReviewerSubmissionPairs.mockResolvedValue(
      new Set(['iterative-reviewer-resource:submission-1']),
    );

    await service.handleIterativePhaseOpened('challenge-1', phase.id);

    expect(reviewService.createPendingReview.mock.calls).toHaveLength(0);
    expect(schedulerService.schedulePhaseTransition.mock.calls).toHaveLength(0);
    expect(schedulerService.advancePhase.mock.calls).toHaveLength(0);
    expect(
      challengeApiService.createIterativeReviewPhase.mock.calls,
    ).toHaveLength(0);
  });

  it('skips stale open iterative phases', async () => {
    const stalePhase = createIterativePhase({
      id: 'stale-iterative-phase',
      actualStartDate: '2026-05-18T00:00:00.000Z',
    });
    const latestPhase = createIterativePhase({
      id: 'latest-iterative-phase',
      actualStartDate: '2026-05-18T01:00:00.000Z',
    });
    challengeApiService.getChallengeById.mockResolvedValue(
      createChallenge([stalePhase, latestPhase]),
    );

    await service.handleIterativePhaseOpened('challenge-1', stalePhase.id);

    expect(reviewService.getPendingReviewCount.mock.calls).toHaveLength(0);
    expect(reviewService.createPendingReview.mock.calls).toHaveLength(0);
    expect(schedulerService.advancePhase.mock.calls).toHaveLength(0);
    expect(
      challengeApiService.createIterativeReviewPhase.mock.calls,
    ).toHaveLength(0);
  });
});
