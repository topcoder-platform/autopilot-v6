jest.mock('../../kafka/kafka.service', () => ({
  KafkaService: jest.fn().mockImplementation(() => ({})),
}));
/* eslint-disable @typescript-eslint/unbound-method */

import { AutopilotService } from './autopilot.service';
import type {
  ReviewCompletedPayload,
  SubmissionAggregatePayload,
} from '../interfaces/autopilot.interface';
import {
  POST_MORTEM_PHASE_NAME,
  POST_MORTEM_PHASE_ALTERNATE_NAME,
} from '../constants/review.constants';
import type { PhaseScheduleManager } from './phase-schedule-manager.service';
import type { ResourceEventHandler } from './resource-event-handler.service';
import type { First2FinishService } from './first2finish.service';
import type { SchedulerService } from './scheduler.service';
import type { ChallengeApiService } from '../../challenge/challenge-api.service';
import type { ReviewService } from '../../review/review.service';
import type { PhaseReviewService } from './phase-review.service';
import type { ConfigService } from '@nestjs/config';
import type {
  IChallenge,
  IPhase,
} from '../../challenge/interfaces/challenge.interface';
import type { ResourcesService } from '../../resources/resources.service';

const createMockMethod = <T extends (...args: any[]) => any>() =>
  jest.fn<ReturnType<T>, Parameters<OmitThisParameter<T>>>();

type First2FinishServiceMock = Pick<
  jest.Mocked<First2FinishService>,
  | 'handleSubmissionByChallengeId'
  | 'handleIterativeReviewerAdded'
  | 'handleIterativeReviewCompletion'
  | 'isFirst2FinishChallenge'
  | 'isChallengeActive'
>;

describe('AutopilotService - handleSubmissionNotificationAggregate', () => {
  const createPayload = (
    overrides: Partial<SubmissionAggregatePayload> = {},
  ): SubmissionAggregatePayload => ({
    resource: 'submission',
    id: 'submission-1',
    originalTopic: 'submission.notification.create',
    v5ChallengeId: 'challenge-123',
    ...overrides,
  });

  let phaseScheduleManager: jest.Mocked<PhaseScheduleManager>;

  let resourceEventHandler: jest.Mocked<ResourceEventHandler>;

  let first2FinishService: First2FinishServiceMock;
  let schedulerService: jest.Mocked<SchedulerService>;
  let challengeApiService: jest.Mocked<ChallengeApiService>;
  let reviewService: jest.Mocked<ReviewService>;
  let resourcesService: jest.Mocked<ResourcesService>;
  let phaseReviewService: jest.Mocked<PhaseReviewService>;
  let configService: jest.Mocked<ConfigService>;
  let autopilotService: AutopilotService;

  beforeEach(() => {
    phaseScheduleManager = {
      schedulePhaseTransition: jest.fn(),
      cancelPhaseTransition: jest.fn(),
      reschedulePhaseTransition: jest.fn(),
      handlePhaseTransition: jest.fn(),
      handleNewChallenge: jest.fn(),
      handleChallengeUpdate: jest.fn(),
      cancelAllPhasesForChallenge: jest.fn(),
      processPhaseChain: jest.fn(),
      getActiveSchedulesSnapshot: jest.fn().mockReturnValue(new Map()),
    } as unknown as jest.Mocked<PhaseScheduleManager>;

    resourceEventHandler = {
      handleResourceCreated: jest.fn(),
      handleResourceDeleted: jest.fn(),
    } as unknown as jest.Mocked<ResourceEventHandler>;

    const handleSubmissionByChallengeId =
      createMockMethod<First2FinishService['handleSubmissionByChallengeId']>();
    handleSubmissionByChallengeId.mockResolvedValue(undefined);

    const handleIterativeReviewerAdded =
      createMockMethod<First2FinishService['handleIterativeReviewerAdded']>();
    const handleIterativeReviewCompletion =
      createMockMethod<
        First2FinishService['handleIterativeReviewCompletion']
      >();

    first2FinishService = {
      handleSubmissionByChallengeId,
      handleIterativeReviewerAdded,
      handleIterativeReviewCompletion,
      isFirst2FinishChallenge: jest.fn().mockReturnValue(true),
      isChallengeActive: jest.fn().mockReturnValue(true),
    } as unknown as First2FinishServiceMock;

    schedulerService = {
      getAllScheduledTransitions: jest.fn().mockReturnValue([]),
      getAllScheduledTransitionsWithData: jest.fn().mockReturnValue(new Map()),
      advancePhase: jest.fn(),
    } as unknown as jest.Mocked<SchedulerService>;

    challengeApiService = {
      getChallengeById: jest.fn(),
      advancePhase: jest.fn(),
      getPhaseTypeName: jest.fn(),
      createIterativeReviewPhase: jest.fn(),
      createApprovalPhase: jest.fn(),
      createFinalFixPhase: jest.fn(),
      createFinalFixPhaseAfterApproval: jest.fn(),
    } as unknown as jest.Mocked<ChallengeApiService>;

    reviewService = {
      getReviewById: jest.fn(),
      getActiveSubmissionCount: jest.fn(),
      getCompletedReviewCountForPhase: jest.fn(),
      getScorecardPassingScore: jest.fn(),
      getPendingReviewCount: jest.fn(),
      createPendingReview: jest.fn(),
    } as unknown as jest.Mocked<ReviewService>;

    reviewService.createPendingReview.mockResolvedValue(false);

    resourcesService = {
      getReviewerResources: jest.fn(),
    } as unknown as jest.Mocked<ResourcesService>;

    resourcesService.getReviewerResources.mockResolvedValue([]);

    phaseReviewService = {
      handlePhaseOpened: jest.fn(),
    } as unknown as jest.Mocked<PhaseReviewService>;

    configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<ConfigService>;

    autopilotService = new AutopilotService(
      phaseScheduleManager,
      resourceEventHandler,
      first2FinishService as unknown as First2FinishService,
      schedulerService,
      challengeApiService,
      reviewService,
      resourcesService,
      phaseReviewService,
      configService,
    );

    jest.clearAllMocks();
  });

  it('ignores messages that are not submission.create aggregates', async () => {
    await autopilotService.handleSubmissionNotificationAggregate(
      createPayload({ originalTopic: 'submission.notification.update' }),
    );

    expect(
      first2FinishService.handleSubmissionByChallengeId,
    ).not.toHaveBeenCalled();
  });

  it('ignores messages without a v5 challenge id', async () => {
    await autopilotService.handleSubmissionNotificationAggregate(
      createPayload({ v5ChallengeId: undefined }),
    );

    expect(
      first2FinishService.handleSubmissionByChallengeId,
    ).not.toHaveBeenCalled();
  });

  it('delegates to First2FinishService when payload is valid', async () => {
    await autopilotService.handleSubmissionNotificationAggregate(
      createPayload({ id: 'submission-123' }),
    );

    expect(
      first2FinishService.handleSubmissionByChallengeId,
    ).toHaveBeenCalledWith('challenge-123', 'submission-123');
  });

  it('opens a continuation approval when a new submission arrives during an open Final Fix after a failed approval', async () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const twoHoursAgo = new Date(
      now.getTime() - 2 * 60 * 60 * 1000,
    ).toISOString();
    const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    const closedApprovalPhase: IPhase = {
      id: 'phase-approval-1',
      phaseId: 'template-approval',
      name: 'Approval',
      description: 'Approval Phase',
      isOpen: false,
      duration: 3600,
      scheduledStartDate: twoHoursAgo,
      scheduledEndDate: oneHourAgo,
      actualStartDate: twoHoursAgo,
      actualEndDate: oneHourAgo,
      predecessor: 'template-final-fix',
      constraints: [],
    };

    const openFinalFixPhase: IPhase = {
      id: 'phase-final-fix-2',
      phaseId: 'template-final-fix',
      name: 'Final Fix',
      description: 'Final Fix Phase',
      isOpen: true,
      duration: 3600,
      scheduledStartDate: oneHourAgo,
      scheduledEndDate: oneHourLater,
      actualStartDate: oneHourAgo,
      actualEndDate: null,
      predecessor: closedApprovalPhase.id,
      constraints: [],
    };

    const challenge: IChallenge = {
      id: 'challenge-123',
      name: 'Approval Loop Challenge',
      description: null,
      descriptionFormat: 'markdown',
      projectId: 1001,
      typeId: 'type-approval',
      trackId: 'track-approval',
      timelineTemplateId: 'timeline-approval',
      currentPhaseNames: ['Final Fix'],
      tags: [],
      groups: [],
      submissionStartDate: twoHoursAgo,
      submissionEndDate: oneHourLater,
      registrationStartDate: twoHoursAgo,
      registrationEndDate: oneHourAgo,
      startDate: twoHoursAgo,
      endDate: null,
      legacyId: null,
      status: 'ACTIVE',
      createdBy: 'tester',
      updatedBy: 'tester',
      metadata: {},
      phases: [closedApprovalPhase, openFinalFixPhase],
      reviewers: [
        {
          id: 'reviewer-config',
          scorecardId: 'approval-scorecard',
          isMemberReview: true,
          memberReviewerCount: 1,
          phaseId: 'template-approval',
          fixedAmount: 0,
          baseCoefficient: null,
          incrementalCoefficient: null,
          type: null,
          shouldOpenOpportunity: false,
          aiWorkflowId: null,
        },
      ],
      winners: [],
      discussions: [],
      events: [],
      prizeSets: [],
      terms: [],
      skills: [],
      attachments: [],
      track: 'DEVELOP',
      type: 'Standard',
      legacy: {},
      task: {},
      created: twoHoursAgo,
      updated: now.toISOString(),
      overview: {},
      numOfSubmissions: 2,
      numOfCheckpointSubmissions: 0,
      numOfRegistrants: 1,
    };

    const nextApprovalPhase: IPhase = {
      ...closedApprovalPhase,
      id: 'phase-approval-2',
      isOpen: true,
      actualStartDate: now.toISOString(),
      actualEndDate: null,
      predecessor: openFinalFixPhase.id,
    };

    challengeApiService.getChallengeById
      .mockResolvedValueOnce(challenge)
      .mockResolvedValueOnce(challenge);
    challengeApiService.createApprovalPhase.mockResolvedValueOnce(
      nextApprovalPhase,
    );
    resourcesService.getReviewerResources.mockResolvedValueOnce([
      {
        id: 'resource-approval',
        memberId: '123',
        memberHandle: 'approver',
        roleName: 'Approver',
      },
    ]);
    reviewService.createPendingReview.mockResolvedValueOnce(true);

    await autopilotService.handleSubmissionNotificationAggregate(
      createPayload({
        id: 'submission-new',
        type: 'CONTEST_SUBMISSION',
      }),
    );

    expect(challengeApiService.createApprovalPhase).toHaveBeenCalledWith(
      'challenge-123',
      'phase-final-fix-2',
      'template-approval',
      'Approval',
      'Approval Phase',
      expect.any(Number),
    );
    expect(reviewService.createPendingReview).toHaveBeenCalledWith(
      'submission-new',
      'resource-approval',
      'phase-approval-2',
      'approval-scorecard',
      'challenge-123',
    );
  });
  describe('handleReviewCompleted (review phase)', () => {
    const buildReviewPhase = (name = 'Review'): IPhase => ({
      id: 'phase-review',
      phaseId: 'template-review',
      name,
      description: null,
      isOpen: true,
      duration: 7200,
      scheduledStartDate: new Date().toISOString(),
      scheduledEndDate: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
      actualStartDate: new Date().toISOString(),
      actualEndDate: null,
      predecessor: null,
      constraints: [],
    });

    const buildAppealsPhase = (): IPhase => ({
      id: 'phase-appeals',
      phaseId: 'template-appeals',
      name: 'Appeals',
      description: null,
      isOpen: false,
      duration: 3600,
      scheduledStartDate: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
      scheduledEndDate: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
      actualStartDate: null,
      actualEndDate: null,
      predecessor: 'template-review',
      constraints: [],
    });

    const buildReviewChallenge = (
      reviewPhase: IPhase = buildReviewPhase(),
    ): IChallenge => ({
      id: 'challenge-1',
      name: 'Test Challenge',
      description: null,
      descriptionFormat: 'markdown',
      projectId: 1001,
      typeId: 'type-1',
      trackId: 'track-1',
      timelineTemplateId: 'timeline-1',
      currentPhaseNames: [reviewPhase.name],
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
      createdBy: 'tester',
      updatedBy: 'tester',
      metadata: {},
      phases: [reviewPhase, buildAppealsPhase()],
      reviewers: [
        {
          id: 'reviewer-config',
          scorecardId: 'scorecard-1',
          isMemberReview: true,
          memberReviewerCount: 1,
          phaseId: 'template-review',
          fixedAmount: 0,
          baseCoefficient: null,
          incrementalCoefficient: null,
          type: null,
          shouldOpenOpportunity: false,
          aiWorkflowId: null,
        },
      ],
      winners: [],
      discussions: [],
      events: [],
      prizeSets: [],
      terms: [],
      skills: [],
      attachments: [],
      track: 'DEVELOP',
      type: 'Standard',
      legacy: {},
      task: {},
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      overview: {},
      numOfSubmissions: 2,
      numOfCheckpointSubmissions: 0,
      numOfRegistrants: 0,
    });

    const buildPayload = (
      overrides: Partial<ReviewCompletedPayload> = {},
    ): ReviewCompletedPayload => ({
      challengeId: 'challenge-1',
      reviewId: 'review-1',
      submissionId: 'sub-1',
      phaseId: 'phase-review',
      scorecardId: 'scorecard-1',
      reviewerResourceId: 'resource-1',
      reviewerHandle: 'reviewer',
      reviewerMemberId: '1',
      submitterHandle: 'submitter',
      submitterMemberId: '2',
      completedAt: new Date().toISOString(),
      initialScore: 90,
      ...overrides,
    });

    beforeEach(() => {
      reviewService.getPendingReviewCount.mockResolvedValue(0);
    });

    it('does not close the review phase while reviews are still pending', async () => {
      const reviewPhase = buildReviewPhase();
      challengeApiService.getChallengeById.mockResolvedValue(
        buildReviewChallenge(reviewPhase),
      );

      reviewService.getReviewById.mockResolvedValue({
        id: 'review-1',
        phaseId: reviewPhase.id,
        resourceId: 'resource-1',
        submissionId: 'sub-1',
        scorecardId: 'scorecard-1',
        score: null,
        status: 'COMPLETED',
      });
      reviewService.getPendingReviewCount.mockResolvedValueOnce(1);

      await autopilotService.handleReviewCompleted(buildPayload());

      expect(reviewService.getPendingReviewCount).toHaveBeenCalledWith(
        reviewPhase.id,
        'challenge-1',
      );
      expect(schedulerService.advancePhase).not.toHaveBeenCalled();
    });

    it.each([
      'Review',
      'Screening',
      'Checkpoint Screening',
      'Checkpoint Review',
    ])(
      'closes the %s phase once all reviews are completed',
      async (phaseName) => {
        const reviewPhase = buildReviewPhase(phaseName);
        challengeApiService.getChallengeById.mockResolvedValue(
          buildReviewChallenge(reviewPhase),
        );

        reviewService.getReviewById.mockResolvedValue({
          id: 'review-1',
          phaseId: reviewPhase.id,
          resourceId: 'resource-1',
          submissionId: 'sub-1',
          scorecardId: 'scorecard-1',
          score: null,
          status: 'COMPLETED',
        });

        await autopilotService.handleReviewCompleted(
          buildPayload({ phaseId: reviewPhase.id }),
        );

        expect(reviewService.getPendingReviewCount).toHaveBeenCalledWith(
          reviewPhase.id,
          'challenge-1',
        );
        expect(schedulerService.advancePhase).toHaveBeenCalledWith(
          expect.objectContaining({
            challengeId: 'challenge-1',
            phaseId: reviewPhase.id,
            phaseTypeName: reviewPhase.name,
            state: 'END',
          }),
        );
      },
    );

    it('falls back to payload phase id when review record lacks a phase reference', async () => {
      const reviewPhase = buildReviewPhase();
      challengeApiService.getChallengeById.mockResolvedValue(
        buildReviewChallenge(reviewPhase),
      );

      reviewService.getReviewById.mockResolvedValue({
        id: 'review-1',
        phaseId: null,
        resourceId: 'resource-1',
        submissionId: 'sub-1',
        scorecardId: 'scorecard-1',
        score: null,
        status: 'COMPLETED',
      });

      await autopilotService.handleReviewCompleted(
        buildPayload({ phaseId: reviewPhase.id }),
      );

      expect(reviewService.getPendingReviewCount).toHaveBeenCalledWith(
        reviewPhase.id,
        'challenge-1',
      );
      expect(schedulerService.advancePhase).toHaveBeenCalledWith(
        expect.objectContaining({
          challengeId: 'challenge-1',
          phaseId: reviewPhase.id,
        }),
      );
    });

    it('matches challenge phase on template id when review references phase template', async () => {
      const reviewPhase = buildReviewPhase();
      challengeApiService.getChallengeById.mockResolvedValue(
        buildReviewChallenge(reviewPhase),
      );

      reviewService.getReviewById.mockResolvedValue({
        id: 'review-1',
        phaseId: reviewPhase.phaseId,
        resourceId: 'resource-1',
        submissionId: 'sub-1',
        scorecardId: 'scorecard-1',
        score: null,
        status: 'COMPLETED',
      });

      await autopilotService.handleReviewCompleted(
        buildPayload({ phaseId: 'unrelated-phase-id' }),
      );

      expect(reviewService.getPendingReviewCount).toHaveBeenCalledWith(
        reviewPhase.id,
        'challenge-1',
      );
      expect(schedulerService.advancePhase).toHaveBeenCalledWith(
        expect.objectContaining({
          challengeId: 'challenge-1',
          phaseId: reviewPhase.id,
        }),
      );
    });
  });

  describe('handleReviewCompleted (approval phase)', () => {
    const buildApprovalPhase = (overrides: Partial<IPhase> = {}): IPhase => ({
      id: 'phase-approval',
      phaseId: 'template-approval',
      name: 'Approval',
      description: 'Approval Phase',
      isOpen: true,
      duration: 7200,
      scheduledStartDate: new Date().toISOString(),
      scheduledEndDate: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
      actualStartDate: new Date().toISOString(),
      actualEndDate: null,
      predecessor: 'template-final-fix',
      constraints: [],
      ...overrides,
    });

    const buildFinalFixPhase = (overrides: Partial<IPhase> = {}): IPhase => ({
      id: 'phase-final-fix',
      phaseId: 'template-final-fix',
      name: 'Final Fix',
      description: 'Final Fix Phase',
      isOpen: false,
      duration: 7200,
      scheduledStartDate: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      scheduledEndDate: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
      actualStartDate: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      actualEndDate: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
      predecessor: null,
      constraints: [],
      ...overrides,
    });

    const buildChallenge = (phases: IPhase[]): IChallenge => ({
      id: 'challenge-approval',
      name: 'Approval Challenge',
      description: null,
      descriptionFormat: 'markdown',
      projectId: 999,
      typeId: 'type-approval',
      trackId: 'track-approval',
      timelineTemplateId: 'timeline-approval',
      currentPhaseNames: phases
        .filter((phase) => phase.isOpen)
        .map((phase) => phase.name),
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
      createdBy: 'tester',
      updatedBy: 'tester',
      metadata: {},
      phases,
      reviewers: [],
      winners: [],
      discussions: [],
      events: [],
      prizeSets: [],
      terms: [],
      skills: [],
      attachments: [],
      track: 'DEVELOP',
      type: 'Standard',
      legacy: {},
      task: {},
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      overview: {},
      numOfSubmissions: 1,
      numOfCheckpointSubmissions: 0,
      numOfRegistrants: 0,
    });

    const buildPayload = (
      overrides: Partial<ReviewCompletedPayload> = {},
    ): ReviewCompletedPayload => ({
      challengeId: 'challenge-approval',
      reviewId: 'review-approval',
      submissionId: 'submission-approval',
      phaseId: 'phase-approval',
      scorecardId: 'scorecard-approval',
      reviewerResourceId: 'resource-approval',
      reviewerHandle: 'approver',
      reviewerMemberId: '123',
      submitterHandle: 'submitter',
      submitterMemberId: '456',
      completedAt: new Date().toISOString(),
      initialScore: 92,
      ...overrides,
    });

    beforeEach(() => {
      const approvalPhase = buildApprovalPhase();
      challengeApiService.getChallengeById.mockResolvedValue(
        buildChallenge([approvalPhase]),
      );

      reviewService.getReviewById.mockResolvedValue({
        id: 'review-approval',
        phaseId: approvalPhase.id,
        resourceId: 'resource-approval',
        submissionId: 'submission-approval',
        scorecardId: 'scorecard-approval',
        score: 0,
        status: 'COMPLETED',
      });
    });

    it('closes the approval phase and closes any open Final Fix phases when the score meets the minimum', async () => {
      const openFinalFix = buildFinalFixPhase({
        id: 'phase-final-fix-open',
        isOpen: true,
        actualEndDate: null,
      });
      challengeApiService.getChallengeById.mockResolvedValueOnce(
        buildChallenge([buildApprovalPhase(), openFinalFix]),
      );

      reviewService.getReviewById.mockResolvedValueOnce({
        id: 'review-approval',
        phaseId: 'phase-approval',
        resourceId: 'resource-approval',
        submissionId: 'submission-approval',
        scorecardId: 'scorecard-approval',
        score: 95,
        status: 'COMPLETED',
      });
      reviewService.getScorecardPassingScore.mockResolvedValueOnce(75);

      await autopilotService.handleReviewCompleted(buildPayload());

      expect(schedulerService.advancePhase).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          challengeId: 'challenge-approval',
          phaseId: 'phase-approval',
          state: 'END',
        }),
      );
      expect(schedulerService.advancePhase).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          challengeId: 'challenge-approval',
          phaseId: 'phase-final-fix-open',
          phaseTypeName: 'Final Fix',
          state: 'END',
        }),
      );
      expect(challengeApiService.createFinalFixPhase).not.toHaveBeenCalled();
    });

    it('opens a continuation Final Fix phase when the approval score is below the minimum', async () => {
      const finalFixTemplate = buildFinalFixPhase({
        id: 'phase-final-fix-1',
        isOpen: false,
      });
      const approvalPhase = buildApprovalPhase({
        predecessor: finalFixTemplate.phaseId,
      });
      challengeApiService.getChallengeById.mockResolvedValueOnce(
        buildChallenge([finalFixTemplate, approvalPhase]),
      );

      reviewService.getScorecardPassingScore.mockResolvedValueOnce(90);
      reviewService.getReviewById.mockResolvedValueOnce({
        id: 'review-approval',
        phaseId: 'phase-approval',
        resourceId: 'resource-approval',
        submissionId: 'submission-approval',
        scorecardId: 'scorecard-approval',
        score: 72,
        status: 'COMPLETED',
      });
      const followUpFinalFix: IPhase = {
        ...finalFixTemplate,
        id: 'phase-final-fix-2',
        isOpen: true,
        actualEndDate: null,
        predecessor: approvalPhase.id,
      };
      challengeApiService.createFinalFixPhase.mockResolvedValueOnce(
        followUpFinalFix,
      );

      await autopilotService.handleReviewCompleted(buildPayload());

      expect(schedulerService.advancePhase).toHaveBeenCalledWith(
        expect.objectContaining({
          challengeId: 'challenge-approval',
          phaseId: 'phase-approval',
          state: 'END',
          preventFinalization: true,
          skipPhaseChain: true,
        }),
      );
      expect(challengeApiService.createFinalFixPhase).toHaveBeenCalledWith(
        'challenge-approval',
        'phase-approval',
        'template-final-fix',
        'Final Fix',
        'Final Fix Phase',
        expect.any(Number),
      );
      expect(challengeApiService.createApprovalPhase).not.toHaveBeenCalled();
      expect(reviewService.createPendingReview).not.toHaveBeenCalled();
    });

    it('creates fallback Final Fix by phase type when challenge timeline has no Final Fix template', async () => {
      const approvalPhase = buildApprovalPhase({
        predecessor: null,
      });
      challengeApiService.getChallengeById.mockResolvedValueOnce(
        buildChallenge([approvalPhase]),
      );

      reviewService.getScorecardPassingScore.mockResolvedValueOnce(90);
      reviewService.getReviewById.mockResolvedValueOnce({
        id: 'review-approval',
        phaseId: 'phase-approval',
        resourceId: 'resource-approval',
        submissionId: 'submission-approval',
        scorecardId: 'scorecard-approval',
        score: 72,
        status: 'COMPLETED',
      });

      const fallbackFinalFix: IPhase = {
        ...buildFinalFixPhase(),
        id: 'phase-final-fix-fallback',
        isOpen: true,
        actualEndDate: null,
        predecessor: approvalPhase.id,
      };
      challengeApiService.createFinalFixPhaseAfterApproval.mockResolvedValueOnce(
        fallbackFinalFix,
      );

      await autopilotService.handleReviewCompleted(buildPayload());

      expect(
        challengeApiService.createFinalFixPhaseAfterApproval,
      ).toHaveBeenCalledWith(
        'challenge-approval',
        'phase-approval',
        expect.any(Number),
      );
      expect(challengeApiService.createFinalFixPhase).not.toHaveBeenCalled();
    });
  });

  describe('handleReviewCompleted (post-mortem)', () => {
    const buildPhase = (name = POST_MORTEM_PHASE_NAME): IPhase => ({
      id: 'phase-1',
      phaseId: 'template-1',
      name,
      description: null,
      isOpen: true,
      duration: 0,
      scheduledStartDate: new Date().toISOString(),
      scheduledEndDate: new Date(Date.now() + 3600 * 1000).toISOString(),
      actualStartDate: new Date().toISOString(),
      actualEndDate: null,
      predecessor: null,
      constraints: [],
    });

    const buildChallenge = (phase: IPhase = buildPhase()): IChallenge => ({
      id: 'challenge-1',
      name: 'Test Challenge',
      description: null,
      descriptionFormat: 'markdown',
      projectId: 1001,
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
      track: 'DEVELOP',
      type: 'First2Finish',
      legacy: {},
      task: {},
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      overview: {},
      numOfSubmissions: 0,
      numOfCheckpointSubmissions: 0,
      numOfRegistrants: 0,
    });

    const buildPayload = (): ReviewCompletedPayload => ({
      challengeId: 'challenge-1',
      reviewId: 'review-1',
      submissionId: 'submission-1',
      phaseId: 'phase-1',
      scorecardId: 'scorecard-1',
      reviewerResourceId: 'resource-1',
      reviewerHandle: 'handle',
      reviewerMemberId: '1',
      submitterHandle: 'submitter',
      submitterMemberId: '2',
      completedAt: new Date().toISOString(),
      initialScore: 0,
    });

    beforeEach(() => {
      const completedReview = {
        id: 'review-1',
        phaseId: 'phase-1',
        resourceId: 'resource-1',
        submissionId: null,
        scorecardId: 'scorecard-1',
        score: null,
        status: 'COMPLETED',
      } satisfies Exclude<
        Awaited<ReturnType<ReviewService['getReviewById']>>,
        null
      >;

      reviewService.getReviewById.mockResolvedValue(completedReview);

      challengeApiService.getChallengeById.mockResolvedValue(buildChallenge());
      reviewService.getPendingReviewCount.mockResolvedValue(0);
    });

    it('does not close the phase when post-mortem reviews are still pending', async () => {
      reviewService.getPendingReviewCount.mockResolvedValueOnce(2);

      await autopilotService.handleReviewCompleted(buildPayload());

      const advancePhaseMock = schedulerService.advancePhase as jest.Mock;
      expect(advancePhaseMock).not.toHaveBeenCalled();
    });

    it('closes the post-mortem phase when all reviews are complete', async () => {
      await autopilotService.handleReviewCompleted(buildPayload());

      const advancePhaseMock = schedulerService.advancePhase as jest.Mock;

      expect(advancePhaseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          challengeId: 'challenge-1',
          phaseId: 'phase-1',
          phaseTypeName: POST_MORTEM_PHASE_NAME,
          state: 'END',
        }),
      );
    });

    it('closes the phase when the Post-mortem alias is used', async () => {
      const postMortemAliasPhase = buildPhase(POST_MORTEM_PHASE_ALTERNATE_NAME);
      challengeApiService.getChallengeById.mockResolvedValue(
        buildChallenge(postMortemAliasPhase),
      );

      await autopilotService.handleReviewCompleted(buildPayload());

      const advancePhaseMock = schedulerService.advancePhase as jest.Mock;

      expect(advancePhaseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          challengeId: 'challenge-1',
          phaseId: 'phase-1',
          phaseTypeName: POST_MORTEM_PHASE_ALTERNATE_NAME,
          state: 'END',
        }),
      );
    });
  });
});
