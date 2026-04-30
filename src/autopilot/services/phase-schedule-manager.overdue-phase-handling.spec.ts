import { PhaseScheduleManager } from './phase-schedule-manager.service';
import { AutopilotOperator } from '../interfaces/autopilot.interface';
import type {
  IChallenge,
  IPhase,
} from '../../challenge/interfaces/challenge.interface';
import type { SchedulerService } from './scheduler.service';
import type { ChallengeApiService } from '../../challenge/challenge-api.service';
import type { PhaseReviewService } from './phase-review.service';
import type { ReviewAssignmentService } from './review-assignment.service';
import type { ReviewService } from '../../review/review.service';
import type { ReviewApiService } from '../../review/review-api.service';
import type { ConfigService } from '@nestjs/config';
import type { AutopilotDbLoggerService } from './autopilot-db-logger.service';
import type { FinanceApiService } from '../../finance/finance-api.service';

const createMockMethod = <T extends (...args: any[]) => any>() =>
  jest.fn<ReturnType<T>, Parameters<T>>();

const buildPhase = (
  id: string,
  name: string,
  scheduledEndDate: string,
): IPhase => ({
  id,
  phaseId: `${id}-template`,
  name,
  description: null,
  isOpen: true,
  duration: 3600,
  scheduledStartDate: new Date('2026-01-01T00:00:00Z').toISOString(),
  scheduledEndDate,
  actualStartDate: new Date('2026-01-01T00:00:00Z').toISOString(),
  actualEndDate: null,
  predecessor: null,
  constraints: [],
});

const buildChallenge = (phases: IPhase[]): IChallenge => ({
  id: 'challenge-1',
  name: 'Challenge',
  description: null,
  descriptionFormat: 'markdown',
  projectId: 1001,
  typeId: 'type-1',
  trackId: 'track-1',
  timelineTemplateId: 'timeline-1',
  currentPhaseNames: phases.map((phase) => phase.name),
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
  type: 'Code',
  legacy: {},
  task: {},
  created: new Date('2025-12-31T00:00:00Z').toISOString(),
  updated: new Date('2026-01-03T00:00:00Z').toISOString(),
  overview: {},
  numOfSubmissions: 0,
  numOfCheckpointSubmissions: 0,
  numOfRegistrants: 0,
});

describe('PhaseScheduleManager overdue phase handling', () => {
  it('only immediately processes schedule-driven overdue phases', async () => {
    const overdueTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const challenge = buildChallenge([
      buildPhase('submission-phase', 'Submission', overdueTimestamp),
      buildPhase('appeals-phase', 'Appeals', overdueTimestamp),
      buildPhase('review-phase', 'Review', overdueTimestamp),
      buildPhase('screening-phase', 'Screening', overdueTimestamp),
      buildPhase(
        'checkpoint-submission-phase',
        'Checkpoint Submission',
        overdueTimestamp,
      ),
    ]);

    const schedulerService = {
      setPhaseChainCallback: jest.fn(),
      buildJobId: jest.fn((challengeId: string, phaseId: string) => {
        return `${challengeId}|${phaseId}`;
      }),
      getScheduledTransition: jest.fn().mockReturnValue(undefined),
      cancelScheduledTransition:
        createMockMethod<SchedulerService['cancelScheduledTransition']>(),
      advancePhase: createMockMethod<SchedulerService['advancePhase']>(),
    };

    const challengeApiService = {
      getPhaseDetails:
        createMockMethod<ChallengeApiService['getPhaseDetails']>(),
    };

    challengeApiService.getPhaseDetails.mockImplementation(
      (_challengeId: string, phaseId: string) =>
        Promise.resolve(
          challenge.phases.find((phase) => phase.id === phaseId) ?? null,
        ),
    );

    const service = new PhaseScheduleManager(
      schedulerService as unknown as SchedulerService,
      challengeApiService as unknown as ChallengeApiService,
      {} as unknown as PhaseReviewService,
      {} as unknown as ReviewAssignmentService,
      {} as unknown as ReviewService,
      {} as unknown as ReviewApiService,
      {
        get: jest.fn().mockReturnValue(undefined),
      } as unknown as ConfigService,
      {
        logAction: jest.fn(),
      } as unknown as AutopilotDbLoggerService,
      {
        generateChallengePayments: jest.fn().mockResolvedValue(true),
      } as unknown as FinanceApiService,
    );

    const processedCount = await (
      service as unknown as {
        processPastDueOpenPhases: (challenge: IChallenge) => Promise<number>;
      }
    ).processPastDueOpenPhases(challenge);

    expect(processedCount).toBe(3);
    expect(
      schedulerService.advancePhase.mock.calls.map(
        ([payload]) => payload.phaseTypeName,
      ),
    ).toEqual(['Submission', 'Appeals', 'Checkpoint Submission']);
    expect(challengeApiService.getPhaseDetails.mock.calls).toHaveLength(3);
    expect(schedulerService.advancePhase.mock.calls).toEqual([
      [
        expect.objectContaining({
          challengeId: challenge.id,
          phaseId: 'submission-phase',
          phaseTypeName: 'Submission',
          state: 'END',
          operator: AutopilotOperator.SYSTEM_SYNC,
        }),
      ],
      [
        expect.objectContaining({
          challengeId: challenge.id,
          phaseId: 'appeals-phase',
          phaseTypeName: 'Appeals',
          state: 'END',
          operator: AutopilotOperator.SYSTEM_SYNC,
        }),
      ],
      [
        expect.objectContaining({
          challengeId: challenge.id,
          phaseId: 'checkpoint-submission-phase',
          phaseTypeName: 'Checkpoint Submission',
          state: 'END',
          operator: AutopilotOperator.SYSTEM_SYNC,
        }),
      ],
    ]);
  });
});
