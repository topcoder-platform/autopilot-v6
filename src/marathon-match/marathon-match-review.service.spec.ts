import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  IChallenge,
  IPhase,
} from '../challenge/interfaces/challenge.interface';
import {
  type ActiveContestSubmission,
  ReviewService,
} from '../review/review.service';
import { AutopilotDbLoggerService } from '../autopilot/services/autopilot-db-logger.service';
import {
  MarathonMatchApiService,
  type MarathonMatchConfigResponse,
} from './marathon-match-api.service';
import { MarathonMatchReviewService } from './marathon-match-review.service';

const basePhase: IPhase = {
  id: 'phase-review',
  phaseId: 'template-review',
  name: 'Review',
  description: null,
  isOpen: true,
  duration: 86400,
  scheduledStartDate: '2026-05-01T00:00:00.000Z',
  scheduledEndDate: '2026-05-02T00:00:00.000Z',
  actualStartDate: '2026-05-01T00:00:00.000Z',
  actualEndDate: null,
  predecessor: 'phase-submission',
  constraints: [],
};

/**
 * Builds the minimal Marathon Match challenge snapshot used by this service spec.
 * @param phase Review phase to include on the challenge; defaults to the base review phase.
 * @returns Challenge object shaped like the Challenge API response consumed by MarathonMatchReviewService.
 * @throws This helper does not throw.
 */
const createChallenge = (phase: IPhase = basePhase): IChallenge => ({
  id: 'challenge-mm',
  name: 'Marathon Match',
  description: null,
  descriptionFormat: 'markdown',
  projectId: 1001,
  typeId: 'type-mm',
  trackId: 'track-data-science',
  timelineTemplateId: 'timeline-mm',
  currentPhaseNames: ['Review'],
  tags: [],
  groups: [],
  submissionStartDate: '2026-04-30T00:00:00.000Z',
  submissionEndDate: '2026-05-01T00:00:00.000Z',
  registrationStartDate: '2026-04-29T00:00:00.000Z',
  registrationEndDate: '2026-04-30T00:00:00.000Z',
  startDate: '2026-04-29T00:00:00.000Z',
  endDate: null,
  legacyId: null,
  status: 'ACTIVE',
  createdBy: 'tester',
  updatedBy: 'tester',
  metadata: {},
  phases: [phase],
  reviewers: [],
  winners: [],
  discussions: [],
  events: [],
  prizeSets: [],
  terms: [],
  skills: [],
  attachments: [],
  track: 'Data Science',
  type: 'Marathon Match',
  legacy: {},
  task: {},
  created: '2026-04-29T00:00:00.000Z',
  updated: '2026-05-01T00:00:00.000Z',
  overview: {},
  numOfSubmissions: 2,
  numOfCheckpointSubmissions: 0,
  numOfRegistrants: 2,
});

/**
 * Builds a Marathon Match API config response for review dispatch tests.
 * @param overrides Optional response fields to override for one test scenario.
 * @returns Complete Marathon Match config response with a review scorecard by default.
 * @throws This helper does not throw.
 */
const createConfig = (
  overrides: Partial<MarathonMatchConfigResponse> = {},
): MarathonMatchConfigResponse => ({
  id: 'mm-config',
  challengeId: 'challenge-mm',
  reviewScorecardId: 'scorecard-review',
  relativeScoringEnabled: false,
  example: null,
  provisional: null,
  system: null,
  ...overrides,
});

describe('MarathonMatchReviewService', () => {
  let loggerErrorSpy: jest.SpyInstance;
  let loggerLogSpy: jest.SpyInstance;
  let loggerWarnSpy: jest.SpyInstance;
  let service: MarathonMatchReviewService;
  let marathonMatchApiService: {
    getConfig: jest.MockedFunction<MarathonMatchApiService['getConfig']>;
    triggerSystemScore: jest.MockedFunction<
      MarathonMatchApiService['triggerSystemScore']
    >;
  };
  let reviewService: {
    getActiveContestSubmissions: jest.MockedFunction<
      ReviewService['getActiveContestSubmissions']
    >;
    createPendingReview: jest.MockedFunction<
      ReviewService['createPendingReview']
    >;
  };
  let configService: jest.Mocked<ConfigService>;
  let dbLogger: jest.Mocked<AutopilotDbLoggerService>;

  beforeAll(() => {
    loggerErrorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    loggerLogSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    loggerWarnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterAll(() => {
    loggerErrorSpy.mockRestore();
    loggerLogSpy.mockRestore();
    loggerWarnSpy.mockRestore();
  });

  beforeEach(() => {
    marathonMatchApiService = {
      getConfig: jest.fn().mockResolvedValue(createConfig()),
      triggerSystemScore: jest.fn().mockResolvedValue(undefined),
    };
    reviewService = {
      getActiveContestSubmissions: jest.fn().mockResolvedValue([]),
      createPendingReview: jest.fn().mockResolvedValue({
        created: true,
        reviewId: 'review-1',
      }),
    };
    configService = {
      get: jest.fn().mockReturnValue('system-resource'),
    } as unknown as jest.Mocked<ConfigService>;
    dbLogger = {
      logAction: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AutopilotDbLoggerService>;

    service = new MarathonMatchReviewService(
      marathonMatchApiService as unknown as MarathonMatchApiService,
      reviewService as unknown as ReviewService,
      configService,
      dbLogger,
    );
  });

  it('throws when the system resource ID is missing so open review phases can be retried', async () => {
    configService.get.mockReturnValue('');

    await expect(
      service.handleReviewPhaseOpened(createChallenge(), basePhase),
    ).rejects.toThrow('MARATHON_MATCH_SYSTEM_RESOURCE_ID is required');

    const missingSystemResourceLog = dbLogger.logAction.mock.calls.find(
      ([action, payload]) => {
        if (!payload) {
          return false;
        }

        const details = payload.details;
        return (
          action === 'marathonMatch.handleReviewPhaseOpened' &&
          payload.challengeId === 'challenge-mm' &&
          payload.status === 'INFO' &&
          payload.source === MarathonMatchReviewService.name &&
          details !== null &&
          details !== undefined &&
          !Array.isArray(details) &&
          details.phaseId === basePhase.id &&
          details.phaseName === basePhase.name &&
          details.reason === 'missing-system-resource-id'
        );
      },
    );
    expect(missingSystemResourceLog).toBeDefined();
    expect(marathonMatchApiService.getConfig.mock.calls).toHaveLength(0);
    expect(reviewService.createPendingReview.mock.calls).toHaveLength(0);
    expect(marathonMatchApiService.triggerSystemScore.mock.calls).toHaveLength(
      0,
    );
  });

  it('throws when the Marathon Match config has no review scorecard', async () => {
    marathonMatchApiService.getConfig.mockResolvedValueOnce(
      createConfig({ reviewScorecardId: '   ' }),
    );

    await expect(
      service.handleReviewPhaseOpened(createChallenge(), basePhase),
    ).rejects.toThrow('Marathon Match review scorecard is required');

    const missingScorecardLog = dbLogger.logAction.mock.calls.find(
      ([action, payload]) => {
        if (!payload) {
          return false;
        }

        const details = payload.details;
        return (
          action === 'marathonMatch.handleReviewPhaseOpened' &&
          payload.challengeId === 'challenge-mm' &&
          payload.status === 'INFO' &&
          payload.source === MarathonMatchReviewService.name &&
          details !== null &&
          details !== undefined &&
          !Array.isArray(details) &&
          details.phaseId === basePhase.id &&
          details.phaseName === basePhase.name &&
          details.reason === 'missing-review-scorecard'
        );
      },
    );
    expect(missingScorecardLog).toBeDefined();
    expect(reviewService.getActiveContestSubmissions.mock.calls).toHaveLength(
      0,
    );
    expect(reviewService.createPendingReview.mock.calls).toHaveLength(0);
    expect(marathonMatchApiService.triggerSystemScore.mock.calls).toHaveLength(
      0,
    );
  });

  it('throws when the Marathon Match config cannot be loaded', async () => {
    marathonMatchApiService.getConfig.mockResolvedValueOnce(null);

    await expect(
      service.handleReviewPhaseOpened(createChallenge(), basePhase),
    ).rejects.toThrow('Marathon Match config is required');

    const missingConfigLog = dbLogger.logAction.mock.calls.find(
      ([action, payload]) => {
        if (!payload) {
          return false;
        }

        const details = payload.details;
        return (
          action === 'marathonMatch.handleReviewPhaseOpened' &&
          payload.challengeId === 'challenge-mm' &&
          payload.status === 'INFO' &&
          payload.source === MarathonMatchReviewService.name &&
          details !== null &&
          details !== undefined &&
          !Array.isArray(details) &&
          details.phaseId === basePhase.id &&
          details.phaseName === basePhase.name &&
          details.reason === 'missing-marathon-match-config'
        );
      },
    );
    expect(missingConfigLog).toBeDefined();
    expect(reviewService.getActiveContestSubmissions.mock.calls).toHaveLength(
      0,
    );
    expect(reviewService.createPendingReview.mock.calls).toHaveLength(0);
    expect(marathonMatchApiService.triggerSystemScore.mock.calls).toHaveLength(
      0,
    );
  });

  it('creates and dispatches system reviews for latest active submissions', async () => {
    const submissions: ActiveContestSubmission[] = [
      { id: 'old-submission', memberId: 'member-1', isLatest: false },
      { id: 'latest-submission', memberId: 'member-1', isLatest: true },
      { id: 'anonymous-submission', memberId: null, isLatest: true },
    ];
    reviewService.getActiveContestSubmissions.mockResolvedValueOnce(
      submissions,
    );
    reviewService.createPendingReview
      .mockResolvedValueOnce({ created: true, reviewId: 'review-1' })
      .mockResolvedValueOnce({ created: false, reviewId: 'review-2' });

    await service.handleReviewPhaseOpened(createChallenge(), basePhase);

    expect(reviewService.createPendingReview.mock.calls).toEqual([
      [
        'latest-submission',
        'system-resource',
        basePhase.id,
        'scorecard-review',
        'challenge-mm',
      ],
      [
        'anonymous-submission',
        'system-resource',
        basePhase.id,
        'scorecard-review',
        'challenge-mm',
      ],
    ]);
    expect(marathonMatchApiService.triggerSystemScore.mock.calls).toEqual([
      ['review-1', 'latest-submission', 'challenge-mm'],
      ['review-2', 'anonymous-submission', 'challenge-mm'],
    ]);
    const summaryLog = dbLogger.logAction.mock.calls.find(
      ([action, payload]) => {
        if (!payload) {
          return false;
        }

        const details = payload.details;
        return (
          action === 'marathonMatch.handleReviewPhaseOpened' &&
          payload.challengeId === 'challenge-mm' &&
          payload.status === 'SUCCESS' &&
          payload.source === MarathonMatchReviewService.name &&
          details !== null &&
          details !== undefined &&
          !Array.isArray(details) &&
          details.phaseId === basePhase.id &&
          details.activeSubmissionCount === submissions.length &&
          details.latestSubmissionCount === 2 &&
          details.createdCount === 1 &&
          details.dispatchAttemptCount === 2 &&
          details.triggeredCount === 2
        );
      },
    );
    expect(summaryLog).toBeDefined();
  });
});
