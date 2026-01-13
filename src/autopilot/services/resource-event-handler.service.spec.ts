import { ConfigService } from '@nestjs/config';
import { ResourceEventHandler } from './resource-event-handler.service';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { PhaseReviewService } from './phase-review.service';
import { ReviewAssignmentService } from './review-assignment.service';
import { ReviewService } from '../../review/review.service';
import { ResourcesService } from '../../resources/resources.service';
import { First2FinishService } from './first2finish.service';
import { SchedulerService } from './scheduler.service';
import type { ResourceEventPayload } from '../interfaces/autopilot.interface';

jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  return {
    ...actual,
    Logger: jest.fn().mockImplementation(() => ({
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    })),
  };
});

describe('ResourceEventHandler', () => {
  let handler: ResourceEventHandler;

  let challengeApiService: jest.Mocked<ChallengeApiService>;
  let phaseReviewService: jest.Mocked<PhaseReviewService>;
  let reviewAssignmentService: jest.Mocked<ReviewAssignmentService>;
  let reviewService: jest.Mocked<ReviewService>;
  let resourcesService: jest.Mocked<ResourcesService>;
  let configService: jest.Mocked<ConfigService>;
  let first2FinishService: jest.Mocked<First2FinishService>;
  let schedulerService: jest.Mocked<SchedulerService>;

  beforeEach(() => {
    jest.clearAllMocks();

    challengeApiService = {
      getChallengeById: jest.fn(),
    } as unknown as jest.Mocked<ChallengeApiService>;

    phaseReviewService = {
      handlePhaseOpened: jest.fn(),
    } as unknown as jest.Mocked<PhaseReviewService>;

    reviewAssignmentService = {
      ensureAssignmentsOrSchedule: jest.fn(),
      handleReviewerRemoved: jest.fn(),
      clearPolling: jest.fn(),
    } as unknown as jest.Mocked<ReviewAssignmentService>;

    reviewService = {
      deletePendingReviewsForResource: jest.fn(),
      reassignPendingReviewsToResource: jest.fn(),
    } as unknown as jest.Mocked<ReviewService>;

    resourcesService = {
      getResourceById: jest.fn(),
      getRoleNameById: jest.fn(),
      getReviewerResources: jest.fn(),
    } as unknown as jest.Mocked<ResourcesService>;

    configService = {
      get: jest.fn(),
    } as unknown as jest.Mocked<ConfigService>;

    first2FinishService = {
      isFirst2FinishChallenge: jest.fn(),
      handleIterativeReviewerAdded: jest.fn(),
    } as unknown as jest.Mocked<First2FinishService>;

    schedulerService = {
      advancePhase: jest.fn(),
    } as unknown as jest.Mocked<SchedulerService>;

    handler = new ResourceEventHandler(
      challengeApiService,
      phaseReviewService,
      reviewAssignmentService,
      reviewService,
      resourcesService,
      configService,
      first2FinishService,
      schedulerService,
    );

    first2FinishService.isFirst2FinishChallenge.mockReturnValue(false);
  });

  describe('handleResourceCreated', () => {
    const challengeId = 'challenge-123';
    const resourceId = 'resource-abc';

    it('reassigns pending approval reviews to the new approver', async () => {
      const payload: ResourceEventPayload = {
        id: resourceId,
        challengeId,
        memberId: '222',
        memberHandle: 'approver',
        roleId: 'role-approver',
        created: new Date().toISOString(),
        createdBy: 'system',
      };

      resourcesService.getResourceById.mockResolvedValue({
        id: resourceId,
        roleName: 'Approver',
        memberId: 'user-1',
        memberHandle: 'handle',
        challengeId,
        roleId: 'role-approver',
      } as unknown as any);

      challengeApiService.getChallengeById.mockResolvedValue({
        id: challengeId,
        status: 'ACTIVE',
        type: 'Design',
        projectId: 'project-1',
        phases: [
          {
            id: 'phase-approval',
            phaseId: 'phase-template-approval',
            name: 'Approval',
            isOpen: true,
          },
        ],
        reviewers: [],
      } as unknown as any);

      reviewService.reassignPendingReviewsToResource.mockResolvedValue(1);

      await handler.handleResourceCreated(payload);

      expect(reviewService.reassignPendingReviewsToResource).toHaveBeenCalledWith(
        'phase-approval',
        resourceId,
        challengeId,
      );
      expect(phaseReviewService.handlePhaseOpened).not.toHaveBeenCalled();
    });

    it('opens checkpoint screening when a screener is assigned after the phase was deferred', async () => {
      const payload: ResourceEventPayload = {
        id: resourceId,
        challengeId,
        memberId: '333',
        memberHandle: 'screener',
        roleId: 'role-screener',
        created: new Date().toISOString(),
        createdBy: 'system',
      };

      resourcesService.getResourceById.mockResolvedValue({
        id: resourceId,
        roleName: 'Checkpoint Screener',
        memberId: 'user-2',
        memberHandle: 'screener',
        challengeId,
        roleId: 'role-screener',
      } as unknown as any);

      challengeApiService.getChallengeById.mockResolvedValue({
        id: challengeId,
        projectId: 321,
        status: 'ACTIVE',
        type: 'Design',
        phases: [
          {
            id: 'phase-screening',
            phaseId: 'phase-template-screening',
            name: 'Checkpoint Screening',
            isOpen: false,
            scheduledStartDate: new Date(Date.now() - 10_000).toISOString(),
          },
        ],
        reviewers: [
          {
            phaseId: 'phase-template-screening',
            isMemberReview: false,
            memberReviewerCount: 1,
          },
        ],
      } as unknown as any);

      resourcesService.getReviewerResources.mockResolvedValue([
        { id: resourceId },
      ] as unknown as any);

      await handler.handleResourceCreated(payload);

      expect(reviewAssignmentService.ensureAssignmentsOrSchedule).not.toHaveBeenCalled();
      expect(schedulerService.advancePhase).toHaveBeenCalledWith({
        projectId: 321,
        challengeId,
        phaseId: 'phase-screening',
        phaseTypeName: 'Checkpoint Screening',
        state: 'START',
        operator: 'system',
        projectStatus: 'ACTIVE',
      });
    });

    it('defers opening checkpoint screening when no screener is assigned', async () => {
      const payload: ResourceEventPayload = {
        id: resourceId,
        challengeId,
        memberId: '333',
        memberHandle: 'screener',
        roleId: 'role-screener',
        created: new Date().toISOString(),
        createdBy: 'system',
      };

      resourcesService.getResourceById.mockResolvedValue({
        id: resourceId,
        roleName: 'Checkpoint Screener',
        memberId: 'user-2',
        memberHandle: 'screener',
        challengeId,
        roleId: 'role-screener',
      } as unknown as any);

      challengeApiService.getChallengeById.mockResolvedValue({
        id: challengeId,
        projectId: 321,
        status: 'ACTIVE',
        type: 'Design',
        phases: [
          {
            id: 'phase-screening',
            phaseId: 'phase-template-screening',
            name: 'Checkpoint Screening',
            isOpen: false,
            scheduledStartDate: new Date(Date.now() - 10_000).toISOString(),
          },
        ],
        reviewers: [
          {
            phaseId: 'phase-template-screening',
            isMemberReview: false,
            memberReviewerCount: 1,
          },
        ],
      } as unknown as any);

      resourcesService.getReviewerResources.mockResolvedValue([]);

      await handler.handleResourceCreated(payload);

      expect(schedulerService.advancePhase).not.toHaveBeenCalled();
      expect(reviewAssignmentService.ensureAssignmentsOrSchedule).not.toHaveBeenCalled();
    });
  });
});
