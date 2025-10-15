import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import type { Response } from 'supertest';
import { KafkaService } from '../src/kafka/kafka.service';
import { SchedulerService } from '../src/autopilot/services/scheduler.service';
import { ChallengeApiService } from '../src/challenge/challenge-api.service';
import { Auth0Service } from '../src/auth/auth0.service';
import { KAFKA_TOPICS } from '../src/kafka/constants/topics';
import { AutopilotConsumer } from '../src/kafka/consumers/autopilot.consumer';
import { RecoveryService } from '../src/recovery/recovery.service';
import {
  ChallengeUpdatePayload,
  AutopilotOperator,
  ResourceEventPayload,
  ReviewCompletedPayload,
  First2FinishSubmissionPayload,
  TopgearSubmissionPayload,
} from '../src/autopilot/interfaces/autopilot.interface';
import { AutopilotService } from '../src/autopilot/services/autopilot.service';
import { ReviewService } from '../src/review/review.service';
import type { ActiveContestSubmission } from '../src/review/review.service';
import { ResourcesService } from '../src/resources/resources.service';
import { PhaseReviewService } from '../src/autopilot/services/phase-review.service';
import { ReviewAssignmentService } from '../src/autopilot/services/review-assignment.service';
import { ChallengeCompletionService } from '../src/autopilot/services/challenge-completion.service';
import { PhaseScheduleManager } from '../src/autopilot/services/phase-schedule-manager.service';

jest.mock('@platformatic/kafka', () => {
  class MockProducer {
    metadata = jest.fn().mockResolvedValue(undefined);
    close = jest.fn().mockResolvedValue(undefined);
    send = jest.fn().mockResolvedValue(undefined);
    isConnected = jest.fn().mockReturnValue(true);
  }

  class MockConsumer {
    on = jest.fn();
    subscribe = jest.fn().mockResolvedValue(undefined);
    run = jest.fn().mockResolvedValue(undefined);
    stop = jest.fn().mockResolvedValue(undefined);
    close = jest.fn().mockResolvedValue(undefined);
    isConnected = jest.fn().mockReturnValue(true);
    stream = jest.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        // No messages by default
      },
    });
  }

  return {
    Producer: MockProducer,
    Consumer: MockConsumer,
    MessagesStream: class MockMessagesStream {},
    ProduceAcks: { ALL: 'all' },
    jsonDeserializer: jest.fn(),
    jsonSerializer: jest.fn(),
    stringDeserializer: jest.fn(),
    stringSerializer: jest.fn(),
  };
});

jest.mock('bullmq', () => {
  const jobs = new Map<string, any>();

  class MockJob {
    id: string;
    data: any;
    remove = jest.fn().mockImplementation(async () => {
      jobs.delete(this.id);
    });

    constructor(id: string, data: any) {
      this.id = id;
      this.data = data;
    }
  }

  class MockQueue {
    add = jest.fn(async (_name: string, data: any, options?: any) => {
      const jobId = options?.jobId ?? `${Date.now()}`;
      const job = new MockJob(jobId, data);
      jobs.set(jobId, job);
      return job;
    });

    getJob = jest.fn(async (id: string) => jobs.get(id) ?? null);

    close = jest.fn().mockResolvedValue(undefined);

    constructor(_name: string, _opts?: any) {}
  }

  class MockWorker {
    on = jest.fn();
    close = jest.fn().mockResolvedValue(undefined);
    waitUntilReady = jest.fn().mockResolvedValue(undefined);

    constructor(
      _name: string,
      _processor: (job: MockJob) => Promise<void>,
      _opts?: any,
    ) {}
  }

  return {
    Queue: MockQueue,
    Worker: MockWorker,
    Job: MockJob,
  };
});

type AppModuleType = typeof import('../src/app.module').AppModule;
let AppModule: AppModuleType;

process.env.POST_MORTEM_SCORECARD_ID =
  process.env.POST_MORTEM_SCORECARD_ID ?? 'post-mortem-scorecard';
process.env.TOPGEAR_POST_MORTEM_SCORECARD_ID =
  process.env.TOPGEAR_POST_MORTEM_SCORECARD_ID ??
  'topgear-post-mortem-scorecard';
process.env.POST_MORTEM_REVIEW_ROLES =
  process.env.POST_MORTEM_REVIEW_ROLES ?? 'Reviewer,Copilot';
process.env.SUBMITTER_ROLE_NAMES =
  process.env.SUBMITTER_ROLE_NAMES ?? 'Submitter';
process.env.APPEALS_PHASE_NAMES = process.env.APPEALS_PHASE_NAMES ?? 'Appeals';
process.env.APPEALS_RESPONSE_PHASE_NAMES =
  process.env.APPEALS_RESPONSE_PHASE_NAMES ?? 'Appeals Response';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? 'localhost:9092';

const flushPromises = async (): Promise<void> =>
  await new Promise((resolve) => setImmediate(resolve));

// --- Mock Data ---
const mockPastPhaseDate = new Date(Date.now() - 1000 * 60 * 60).toISOString(); // 1 hour ago
const mockFuturePhaseDate1 = new Date(
  Date.now() + 1000 * 60 * 60,
).toISOString(); // 1 hour from now
const mockFuturePhaseDate2 = new Date(
  Date.now() + 1000 * 60 * 120,
).toISOString(); // 2 hours from now

const mockChallenge = {
  id: 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6',
  projectId: 12345,
  status: 'ACTIVE',
  type: 'standard',
  reviewers: [],
  numOfSubmissions: 1,
  phases: [
    {
      id: 'p1a2b3c4-d5e6-f7a8-b9c0-d1e2f3a4b5c6',
      phaseId: 'p1a2b3c4-d5e6-f7a8-b9c0-d1e2f3a4b5c6',
      name: 'Registration',
      isOpen: true,
      scheduledStartDate: mockPastPhaseDate,
      scheduledEndDate: mockFuturePhaseDate1,
      actualStartDate: mockPastPhaseDate,
      actualEndDate: null,
      predecessor: null,
    },
    {
      id: 'p2a3b4c5-d6e7-f8a9-b0c1-d2e3f4a5b6c7',
      phaseId: 'p2a3b4c5-d6e7-f8a9-b0c1-d2e3f4a5b6c7',
      name: 'Submission',
      isOpen: false,
      scheduledStartDate: mockFuturePhaseDate1,
      scheduledEndDate: mockFuturePhaseDate2,
      actualStartDate: null,
      actualEndDate: null,
      predecessor: 'p1a2b3c4-d5e6-f7a8-b9c0-d1e2f3a4b5c6',
    },
  ],
};

const mockChallengeWithPastPhase = {
  ...mockChallenge,
  phases: [
    {
      ...mockChallenge.phases[0],
      scheduledEndDate: mockPastPhaseDate,
      isOpen: true, // This phase is overdue but still open
    },
    mockChallenge.phases[1], // This one is in the future
  ],
};

describe('Autopilot Service (e2e)', () => {
  let app: INestApplication;
  let schedulerService: SchedulerService;
  let autopilotConsumer: AutopilotConsumer;
  let recoveryService: RecoveryService;
  let autopilotService: AutopilotService;
  let phaseScheduleManager: PhaseScheduleManager;
  let mockKafkaProduce: jest.Mock;
  let mockChallengeApiService: {
    getAllActiveChallenges: jest.Mock;
    getChallenge: jest.Mock;
    getChallengeById: jest.Mock;
    getPhaseDetails: jest.Mock;
    getChallengePhases: jest.Mock;
    getPhaseTypeName: jest.Mock;
    advancePhase: jest.Mock;
    createPostMortemPhase: jest.Mock;
    cancelChallenge: jest.Mock;
    completeChallenge: jest.Mock;
  };
  let mockReviewService: jest.Mocked<ReviewService>;
  let mockResourcesService: jest.Mocked<ResourcesService>;
  let mockPhaseReviewService: jest.Mocked<PhaseReviewService>;
  let mockReviewAssignmentService: jest.Mocked<ReviewAssignmentService>;
  let reviewServiceMockFns: Record<string, jest.Mock>;
  let resourcesServiceMockFns: Record<string, jest.Mock>;
  let phaseReviewServiceMockFns: Record<string, jest.Mock>;
  let reviewAssignmentServiceMockFns: Record<string, jest.Mock>;

  beforeEach(async () => {
    jest.clearAllMocks();

    ({ AppModule } = await import('../src/app.module'));

    mockKafkaProduce = jest.fn().mockResolvedValue(null);

    const reviewServiceMock = {
      getPendingReviewCount: jest.fn().mockResolvedValue(0),
      deletePendingReviewsForResource: jest.fn().mockResolvedValue(0),
      createPendingReview: jest.fn().mockResolvedValue(true),
      getActiveSubmissionCount: jest.fn().mockResolvedValue(1),
      getActiveContestSubmissions: jest
        .fn()
        .mockResolvedValue([] as ActiveContestSubmission[]),
      getActiveContestSubmissionIds: jest.fn().mockResolvedValue([]),
      getAllSubmissionIdsOrdered: jest.fn().mockResolvedValue([]),
      getExistingReviewPairs: jest.fn().mockResolvedValue(new Set()),
      getReviewerSubmissionPairs: jest.fn().mockResolvedValue(new Set()),
      getReviewById: jest.fn().mockResolvedValue(null),
      getScorecardPassingScore: jest.fn().mockResolvedValue(50),
      getCompletedReviewCountForPhase: jest.fn().mockResolvedValue(0),
      getPendingAppealCount: jest.fn().mockResolvedValue(0),
      getActiveSubmissionIds: jest.fn().mockResolvedValue([]),
      generateReviewSummaries: jest.fn().mockResolvedValue([]),
    } satisfies Record<string, jest.Mock>;
    reviewServiceMockFns = reviewServiceMock;
    mockReviewService =
      reviewServiceMock as unknown as jest.Mocked<ReviewService>;

    const resourcesServiceMock = {
      getResourceById: jest.fn(),
      getRoleNameById: jest.fn(),
      getReviewerResources: jest.fn().mockResolvedValue([]),
      getResourcesByRoleNames: jest.fn().mockResolvedValue([]),
      hasSubmitterResource: jest.fn().mockResolvedValue(true),
      getMemberHandleMap: jest.fn().mockResolvedValue(new Map()),
      getResourceByMemberHandle: jest.fn(),
    } satisfies Record<string, jest.Mock>;
    resourcesServiceMockFns = resourcesServiceMock;
    mockResourcesService =
      resourcesServiceMock as unknown as jest.Mocked<ResourcesService>;

    const phaseReviewServiceMock = {
      handlePhaseOpened: jest.fn().mockResolvedValue(undefined),
    } satisfies Record<string, jest.Mock>;
    phaseReviewServiceMockFns = phaseReviewServiceMock;
    mockPhaseReviewService =
      phaseReviewServiceMock as unknown as jest.Mocked<PhaseReviewService>;

    const reviewAssignmentServiceMock = {
      ensureAssignmentsOrSchedule: jest.fn().mockResolvedValue(true),
      handleReviewerRemoved: jest.fn().mockResolvedValue(undefined),
      clearPolling: jest.fn(),
      startPolling: jest.fn(),
    } satisfies Record<string, jest.Mock>;
    reviewAssignmentServiceMockFns = reviewAssignmentServiceMock;
    mockReviewAssignmentService =
      reviewAssignmentServiceMock as unknown as jest.Mocked<ReviewAssignmentService>;

    mockChallengeApiService = {
      getAllActiveChallenges: jest.fn().mockResolvedValue([]),
      getChallenge: jest.fn().mockResolvedValue(mockChallenge),
      getChallengeById: jest.fn().mockResolvedValue(mockChallenge),
      getPhaseDetails: jest
        .fn()
        .mockImplementation((challengeId: string, phaseId: string) => {
          const challenge =
            challengeId === mockChallenge.id ? mockChallenge : mockChallenge;
          const phase = challenge.phases.find((p) => p.id === phaseId);
          if (phase) {
            return Promise.resolve(phase);
          }
          return Promise.resolve({
            id: phaseId,
            name: 'Test Phase',
            isOpen: true,
            scheduledStartDate: mockPastPhaseDate,
            scheduledEndDate: mockFuturePhaseDate1,
          });
        }),
      getChallengePhases: jest
        .fn()
        .mockImplementation(async (challengeId: string) => {
          if (challengeId === mockChallenge.id) {
            return mockChallenge.phases;
          }
          return mockChallenge.phases;
        }),
      getPhaseTypeName: jest.fn().mockResolvedValue('Mock Phase'),
      advancePhase: jest
        .fn()
        .mockImplementation(
          (
            challengeId: string,
            phaseId: string,
            operation: 'open' | 'close',
          ) => {
            if (operation === 'close') {
              return Promise.resolve({
                success: true,
                message: 'Phase closed',
                next: {
                  operation: 'open',
                  phases: [
                    {
                      id: 'p2a3b4c5-d6e7-f8a9-b0c1-d2e3f4a5b6c7',
                      name: 'Submission',
                      scheduledEndDate: mockFuturePhaseDate2,
                    },
                  ],
                },
              });
            }

            if (operation === 'open') {
              return Promise.resolve({
                success: true,
                message: 'Phase opened',
                updatedPhases: [
                  {
                    id: 'p2a3b4c5-d6e7-f8a9-b0c1-d2e3f4a5b6c7',
                    name: 'Submission',
                    scheduledEndDate: mockFuturePhaseDate2,
                    isOpen: true,
                    actualStartDate: new Date().toISOString(),
                  },
                ],
              });
            }

            return Promise.resolve({
              success: false,
              message: 'Unknown operation',
            });
          },
        ),
      createPostMortemPhase: jest.fn(),
      cancelChallenge: jest.fn(),
      completeChallenge: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KafkaService)
      .useValue({
        produce: mockKafkaProduce,
        consume: jest.fn(),
        isConnected: jest.fn().mockResolvedValue(true),
      })
      .overrideProvider(Auth0Service)
      .useValue({
        getAccessToken: jest.fn().mockResolvedValue('mock-access-token'),
        clearTokenCache: jest.fn(),
      })
      .overrideProvider(ChallengeApiService)
      .useValue(mockChallengeApiService)
      .overrideProvider(ReviewService)
      .useValue(mockReviewService)
      .overrideProvider(ResourcesService)
      .useValue(mockResourcesService)
      .overrideProvider(PhaseReviewService)
      .useValue(mockPhaseReviewService)
      .overrideProvider(ReviewAssignmentService)
      .useValue(mockReviewAssignmentService)
      .overrideProvider(ChallengeCompletionService)
      .useValue({ finalizeChallenge: jest.fn().mockResolvedValue(true) })
      .compile();

    app = moduleFixture.createNestApplication();

    schedulerService = app.get<SchedulerService>(SchedulerService);
    autopilotConsumer = app.get<AutopilotConsumer>(AutopilotConsumer);
    recoveryService = app.get<RecoveryService>(RecoveryService);
    autopilotService = app.get<AutopilotService>(AutopilotService);
    phaseScheduleManager = app.get<PhaseScheduleManager>(PhaseScheduleManager);

    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should be defined', () => {
    expect(app).toBeDefined();
  });

  describe('Health Checks', () => {
    it('/health (GET) should return OK', () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      return request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect(({ body }: Response) => {
          const typedBody = body as { status: string };
          expect(typedBody.status).toBe('ok');
        });
    });
  });

  describe('Challenge Creation and Scheduling', () => {
    it('should schedule only the next phase when a challenge.notification.create event is received', async () => {
      mockChallengeApiService.getChallengeById.mockResolvedValue(mockChallenge);
      const scheduleSpy = jest.spyOn(
        schedulerService,
        'schedulePhaseTransition',
      );

      await autopilotConsumer.topicHandlers[KAFKA_TOPICS.CHALLENGE_CREATED]({
        id: mockChallenge.id,
        challengeId: mockChallenge.id,
        projectId: mockChallenge.projectId,
        status: 'ACTIVE',
        operator: AutopilotOperator.SYSTEM,
      } as ChallengeUpdatePayload);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockChallengeApiService.getChallengeById).toHaveBeenCalledWith(
        mockChallenge.id,
      );
      // Should only schedule 1 phase (the next one), not all phases
      expect(scheduleSpy).toHaveBeenCalledTimes(1);
      expect(scheduleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: mockChallenge.phases[0].id, // Should schedule the currently open phase
        }),
      );
    });

    it('should schedule the next ready phase when no phases are currently open', async () => {
      const challengeWithNoOpenPhases = {
        ...mockChallenge,
        phases: [
          {
            ...mockChallenge.phases[0],
            isOpen: false,
            actualStartDate: mockPastPhaseDate,
            actualEndDate: mockPastPhaseDate, // This phase has ended
          },
          {
            ...mockChallenge.phases[1],
            isOpen: false,
            actualStartDate: null,
            actualEndDate: null, // This phase is ready to start
            scheduledStartDate: mockPastPhaseDate,
            scheduledEndDate: mockFuturePhaseDate1,
          },
        ],
      };

      mockChallengeApiService.getChallengeById.mockResolvedValue(
        challengeWithNoOpenPhases,
      );
      const scheduleSpy = jest.spyOn(
        schedulerService,
        'schedulePhaseTransition',
      );

      await autopilotConsumer.topicHandlers[KAFKA_TOPICS.CHALLENGE_CREATED]({
        id: challengeWithNoOpenPhases.id,
        challengeId: challengeWithNoOpenPhases.id,
        projectId: challengeWithNoOpenPhases.projectId,
        status: 'ACTIVE',
        operator: AutopilotOperator.SYSTEM,
      } as ChallengeUpdatePayload);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockChallengeApiService.getChallengeById).toHaveBeenCalledWith(
        challengeWithNoOpenPhases.id,
      );
      expect(scheduleSpy).toHaveBeenCalledTimes(1);
      expect(scheduleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: challengeWithNoOpenPhases.phases[1].id, // Should schedule the next ready phase
        }),
      );
    });
  });

  describe('Challenge Update Handling', () => {
    it('should reschedule phases when a challenge.notification.update event is received', async () => {
      const updatedChallenge = {
        ...mockChallenge,
        phases: [
          {
            ...mockChallenge.phases[0],
            scheduledEndDate: new Date().toISOString(),
          },
        ],
      };
      mockChallengeApiService.getChallengeById.mockResolvedValue(
        updatedChallenge,
      );
      const rescheduleSpy = jest.spyOn(
        phaseScheduleManager,
        'reschedulePhaseTransition',
      );

      await autopilotConsumer.topicHandlers[KAFKA_TOPICS.CHALLENGE_UPDATE]({
        id: updatedChallenge.id,
        challengeId: updatedChallenge.id,
        projectId: updatedChallenge.projectId,
        status: 'ACTIVE',
        operator: AutopilotOperator.SYSTEM,
      } as ChallengeUpdatePayload);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockChallengeApiService.getChallengeById).toHaveBeenCalledWith(
        updatedChallenge.id,
      );
      expect(rescheduleSpy).toHaveBeenCalledTimes(1);
      expect(rescheduleSpy).toHaveBeenCalledWith(
        updatedChallenge.id,
        expect.objectContaining({
          phaseId: updatedChallenge.phases[0].id,
        }),
      );
    });
  });

  describe('Command Handling', () => {
    it('should cancel a schedule when a cancel_schedule command is received', async () => {
      await schedulerService.schedulePhaseTransition({
        projectId: mockChallenge.projectId,
        phaseId: mockChallenge.phases[0].id,
        challengeId: mockChallenge.id,
        date: mockChallenge.phases[0].scheduledEndDate,
        phaseTypeName: 'Registration',
        state: 'END',
        operator: AutopilotOperator.SYSTEM,
        projectStatus: 'ACTIVE',
      });

      const autopilotCancelSpy = jest.spyOn(
        phaseScheduleManager,
        'cancelPhaseTransition',
      );

      await autopilotConsumer.topicHandlers[KAFKA_TOPICS.COMMAND]({
        command: 'cancel_schedule',
        projectId: mockChallenge.projectId,
        challengeId: mockChallenge.id,
        phaseId: mockChallenge.phases[0].id,
        operator: AutopilotOperator.ADMIN,
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(autopilotCancelSpy).toHaveBeenCalledWith(
        mockChallenge.id,
        mockChallenge.phases[0].id,
      );
    });
  });

  describe('Recovery Service', () => {
    it('should immediately trigger overdue phases on bootstrap', async () => {
      mockChallengeApiService.getAllActiveChallenges.mockResolvedValue([
        mockChallengeWithPastPhase,
      ]);
      const scheduleSpy = jest.spyOn(
        schedulerService,
        'schedulePhaseTransition',
      );
      const triggerEventSpy = jest.spyOn(schedulerService, 'triggerKafkaEvent');

      await recoveryService.onApplicationBootstrap();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockChallengeApiService.getAllActiveChallenges).toHaveBeenCalled();
      // Should only trigger the overdue phase, not schedule future ones
      expect(scheduleSpy).toHaveBeenCalledTimes(0);
      expect(triggerEventSpy).toHaveBeenCalledTimes(1);

      expect(triggerEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: mockChallengeWithPastPhase.phases[0].id, // The overdue phase
        }),
      );
    });

    it('should skip scheduling when no phases are yet due', async () => {
      const challengeWithFuturePhase = {
        ...mockChallenge,
        phases: [
          {
            ...mockChallenge.phases[0],
            isOpen: false,
            actualStartDate: mockPastPhaseDate,
            actualEndDate: mockPastPhaseDate, // This phase has ended
          },
          {
            ...mockChallenge.phases[1],
            isOpen: false,
            actualStartDate: null,
            actualEndDate: null, // This phase is ready to start
            scheduledStartDate: mockFuturePhaseDate1,
            scheduledEndDate: mockFuturePhaseDate2,
          },
        ],
      };

      mockChallengeApiService.getAllActiveChallenges.mockResolvedValue([
        challengeWithFuturePhase,
      ]);
      const scheduleSpy = jest.spyOn(
        schedulerService,
        'schedulePhaseTransition',
      );
      const triggerEventSpy = jest.spyOn(schedulerService, 'triggerKafkaEvent');

      await recoveryService.onApplicationBootstrap();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockChallengeApiService.getAllActiveChallenges).toHaveBeenCalled();
      expect(scheduleSpy).toHaveBeenCalledTimes(0);
      expect(triggerEventSpy).toHaveBeenCalledTimes(0);

      expect(scheduleSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: challengeWithFuturePhase.phases[1].id,
        }),
      );
    });

    it('should open and schedule next phases in the chain when a phase completes', async () => {
      const scheduleSpy = jest.spyOn(
        schedulerService,
        'schedulePhaseTransition',
      );

      // Simulate a phase transition that triggers the chain
      const phaseData = {
        projectId: mockChallenge.projectId,
        challengeId: mockChallenge.id,
        phaseId: mockChallenge.phases[0].id,
        phaseTypeName: mockChallenge.phases[0].name,
        state: 'END' as const,
        operator: AutopilotOperator.SYSTEM_SCHEDULER,
        projectStatus: 'ACTIVE',
        date: new Date().toISOString(),
      };

      await schedulerService.advancePhase(phaseData);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockChallengeApiService.advancePhase).toHaveBeenCalledWith(
        mockChallenge.id,
        mockChallenge.phases[0].id,
        'close',
      );

      // Should open and schedule the next phase in the chain
      expect(scheduleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          challengeId: mockChallenge.id,
          phaseId: 'p2a3b4c5-d6e7-f8a9-b0c1-d2e3f4a5b6c7',
          state: 'END',
        }),
      );
    });

    it('should handle complete phase chain flow from challenge creation to phase completion', async () => {
      mockChallengeApiService.getChallengeById.mockResolvedValue(mockChallenge);
      const scheduleSpy = jest.spyOn(
        schedulerService,
        'schedulePhaseTransition',
      );

      // 1. Create a new challenge - should schedule only the first phase
      await autopilotConsumer.topicHandlers[KAFKA_TOPICS.CHALLENGE_CREATED]({
        id: mockChallenge.id,
        challengeId: mockChallenge.id,
        projectId: mockChallenge.projectId,
        status: 'ACTIVE',
        operator: AutopilotOperator.SYSTEM,
      } as ChallengeUpdatePayload);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should schedule the first phase (Registration)
      expect(scheduleSpy).toHaveBeenCalledTimes(1);
      expect(scheduleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: mockChallenge.phases[0].id,
          phaseTypeName: 'Registration',
        }),
      );

      // 2. Simulate the first phase completing - should trigger chain scheduling
      const phaseData = {
        projectId: mockChallenge.projectId,
        challengeId: mockChallenge.id,
        phaseId: mockChallenge.phases[0].id,
        phaseTypeName: mockChallenge.phases[0].name,
        state: 'END' as const,
        operator: AutopilotOperator.SYSTEM_SCHEDULER,
        projectStatus: 'ACTIVE',
        date: new Date().toISOString(),
      };

      await schedulerService.advancePhase(phaseData);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have called advancePhase on the API
      expect(mockChallengeApiService.advancePhase).toHaveBeenCalledWith(
        mockChallenge.id,
        mockChallenge.phases[0].id,
        'close',
      );

      // Should have opened the next phase first, then scheduled it for closure
      expect(mockChallengeApiService.advancePhase).toHaveBeenCalledWith(
        mockChallenge.id,
        'p2a3b4c5-d6e7-f8a9-b0c1-d2e3f4a5b6c7',
        'open',
      );

      // Should have scheduled the next phase (Submission) for closure after opening it
      expect(scheduleSpy).toHaveBeenCalledTimes(2);
      expect(scheduleSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          phaseId: 'p2a3b4c5-d6e7-f8a9-b0c1-d2e3f4a5b6c7',
          phaseTypeName: 'Submission',
          operator: AutopilotOperator.SYSTEM_PHASE_CHAIN,
        }),
      );
    });

    it('should open phases before scheduling them for closure', async () => {
      const advancePhaseCallOrder: Array<{
        operation: string;
        phaseId: string;
      }> = [];
      const originalAdvanceImplementation =
        mockChallengeApiService.advancePhase.getMockImplementation();

      mockChallengeApiService.advancePhase.mockImplementation(
        (
          _challengeId: string,
          phaseId: string,
          operation: 'open' | 'close',
        ) => {
          advancePhaseCallOrder.push({ operation, phaseId });

          if (operation === 'close') {
            return Promise.resolve({
              success: true,
              message: 'Phase closed',
              next: {
                operation: 'open',
                phases: [
                  {
                    id: 'next-phase-id',
                    name: 'Next Phase',
                    scheduledEndDate: mockFuturePhaseDate2,
                  },
                ],
              },
            });
          }

          if (operation === 'open') {
            return Promise.resolve({
              success: true,
              message: 'Phase opened',
              updatedPhases: [
                {
                  id: 'next-phase-id',
                  name: 'Next Phase',
                  scheduledEndDate: mockFuturePhaseDate2,
                  isOpen: true,
                  actualStartDate: new Date().toISOString(),
                },
              ],
            });
          }

          return Promise.resolve({
            success: false,
            message: 'Unknown operation',
          });
        },
      );

      // Trigger phase advancement
      const phaseData = {
        projectId: mockChallenge.projectId,
        challengeId: mockChallenge.id,
        phaseId: 'current-phase-id',
        phaseTypeName: 'Current Phase',
        state: 'END' as const,
        operator: AutopilotOperator.SYSTEM_SCHEDULER,
        projectStatus: 'ACTIVE',
        date: new Date().toISOString(),
      };

      await schedulerService.advancePhase(phaseData);
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify the order: close first, then open
      expect(advancePhaseCallOrder).toHaveLength(2);
      expect(advancePhaseCallOrder[0]).toEqual({
        operation: 'close',
        phaseId: 'current-phase-id',
      });
      expect(advancePhaseCallOrder[1]).toEqual({
        operation: 'open',
        phaseId: 'next-phase-id',
      });

      if (originalAdvanceImplementation) {
        mockChallengeApiService.advancePhase.mockImplementation(
          originalAdvanceImplementation,
        );
      }
    });

    it('should not try to close phases that are already closed', async () => {
      // Mock a closed phase
      mockChallengeApiService.getPhaseDetails.mockResolvedValueOnce({
        id: 'closed-phase-id',
        name: 'Closed Phase',
        isOpen: false,
        scheduledEndDate: mockFuturePhaseDate1,
      });
      mockChallengeApiService.advancePhase.mockClear();

      // Trigger phase advancement for a closed phase
      const phaseData = {
        projectId: mockChallenge.projectId,
        challengeId: mockChallenge.id,
        phaseId: 'closed-phase-id',
        phaseTypeName: 'Closed Phase',
        state: 'END' as const,
        operator: AutopilotOperator.SYSTEM_SCHEDULER,
        projectStatus: 'ACTIVE',
        date: new Date().toISOString(),
      };

      await schedulerService.advancePhase(phaseData);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not call advancePhase since the phase is already closed
      expect(mockChallengeApiService.advancePhase).not.toHaveBeenCalled();
    });

    it('should not try to open phases that are already open', async () => {
      // Mock an open phase
      mockChallengeApiService.getPhaseDetails.mockResolvedValueOnce({
        id: 'open-phase-id',
        name: 'Open Phase',
        isOpen: true,
        scheduledStartDate: mockPastPhaseDate,
      });
      mockChallengeApiService.advancePhase.mockClear();

      // Trigger phase advancement for an open phase with START state
      const phaseData = {
        projectId: mockChallenge.projectId,
        challengeId: mockChallenge.id,
        phaseId: 'open-phase-id',
        phaseTypeName: 'Open Phase',
        state: 'START' as const,
        operator: AutopilotOperator.SYSTEM_SCHEDULER,
        projectStatus: 'ACTIVE',
        date: new Date().toISOString(),
      };

      await schedulerService.advancePhase(phaseData);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not call advancePhase since the phase is already open
      expect(mockChallengeApiService.advancePhase).not.toHaveBeenCalled();
    });
  });

  describe('Resource Events', () => {
    it('should create pending reviews when a reviewer resource is added', async () => {
      const challengeId = 'resource-challenge';
      const reviewPhase = {
        id: 'review-phase-id',
        phaseId: 'review-phase-template',
        name: 'Review',
        isOpen: true,
        scheduledStartDate: mockPastPhaseDate,
        scheduledEndDate: mockFuturePhaseDate1,
        actualStartDate: mockPastPhaseDate,
        actualEndDate: null,
        predecessor: null,
      };
      const challengeWithOpenReview = {
        ...mockChallenge,
        id: challengeId,
        phases: [reviewPhase],
      };

      mockChallengeApiService.getChallengeById.mockResolvedValueOnce(
        challengeWithOpenReview,
      );
      resourcesServiceMockFns.getResourceById.mockResolvedValue({
        id: 'resource-1',
        challengeId,
        roleName: 'Reviewer',
      });

      await autopilotService.handleResourceCreated({
        id: 'resource-1',
        challengeId,
        memberId: '111',
        memberHandle: 'reviewer',
        roleId: 'role-1',
        created: new Date().toISOString(),
        createdBy: 'tester',
      } as ResourceEventPayload);

      expect(phaseReviewServiceMockFns.handlePhaseOpened).toHaveBeenCalledWith(
        challengeId,
        reviewPhase.id,
      );
    });

    it('should remove pending reviews when a reviewer resource is deleted', async () => {
      const challengeId = 'resource-challenge-delete';
      const reviewPhase = {
        id: 'review-phase-id',
        phaseId: 'review-phase-template',
        name: 'Review',
        isOpen: true,
        scheduledStartDate: mockPastPhaseDate,
        scheduledEndDate: mockFuturePhaseDate1,
        actualStartDate: mockPastPhaseDate,
        actualEndDate: null,
        predecessor: null,
      };
      const challengeWithReviewPhases = {
        ...mockChallenge,
        id: challengeId,
        phases: [reviewPhase],
      };

      mockChallengeApiService.getChallengeById.mockResolvedValueOnce(
        challengeWithReviewPhases,
      );
      resourcesServiceMockFns.getRoleNameById.mockResolvedValue('Reviewer');
      reviewServiceMockFns.deletePendingReviewsForResource.mockResolvedValueOnce(
        2,
      );

      await autopilotService.handleResourceDeleted({
        id: 'resource-1',
        challengeId,
        memberId: '111',
        memberHandle: 'reviewer',
        roleId: 'role-1',
        created: new Date().toISOString(),
        createdBy: 'tester',
      } as ResourceEventPayload);

      expect(
        reviewServiceMockFns.deletePendingReviewsForResource,
      ).toHaveBeenCalledWith(reviewPhase.id, 'resource-1', challengeId);
      expect(
        reviewAssignmentServiceMockFns.handleReviewerRemoved,
      ).toHaveBeenCalledWith(
        challengeId,
        expect.objectContaining({ id: reviewPhase.id, name: reviewPhase.name }),
      );
    });
  });

  describe('Zero Submission handling', () => {
    it('should create a post-mortem phase when submission phase closes with zero submissions', async () => {
      const challengeId = 'zero-submission-challenge';
      const submissionPhase = {
        id: 'submission-phase-id',
        phaseId: 'submission-template',
        name: 'Submission',
        isOpen: true,
        scheduledStartDate: mockPastPhaseDate,
        scheduledEndDate: mockFuturePhaseDate1,
        actualStartDate: mockPastPhaseDate,
        actualEndDate: null,
        predecessor: null,
      };
      const challengeWithZeroSubmissions = {
        ...mockChallenge,
        id: challengeId,
        numOfSubmissions: 0,
        phases: [submissionPhase],
      };

      mockChallengeApiService.getPhaseDetails.mockResolvedValueOnce(
        submissionPhase,
      );
      mockChallengeApiService.getChallengeById.mockResolvedValueOnce(
        challengeWithZeroSubmissions,
      );
      reviewServiceMockFns.getActiveContestSubmissionIds.mockResolvedValueOnce(
        [],
      );
      resourcesServiceMockFns.getResourcesByRoleNames.mockResolvedValue([
        { id: 'postmortem-reviewer' },
        { id: 'postmortem-copilot' },
      ]);
      const postMortemPhase = {
        id: 'post-mortem-phase-id',
        name: 'Post-Mortem',
        scheduledEndDate: new Date(Date.now() + 3600_000).toISOString(),
      };
      mockChallengeApiService.createPostMortemPhase.mockResolvedValueOnce(
        postMortemPhase,
      );
      const scheduleSpy = jest.spyOn(
        schedulerService,
        'schedulePhaseTransition',
      );

      await schedulerService.advancePhase({
        projectId: challengeWithZeroSubmissions.projectId,
        challengeId,
        phaseId: submissionPhase.id,
        phaseTypeName: submissionPhase.name,
        state: 'END',
        operator: AutopilotOperator.SYSTEM_SCHEDULER,
        projectStatus: 'ACTIVE',
        date: new Date().toISOString(),
      });

      await flushPromises();

      expect(
        mockChallengeApiService.createPostMortemPhase,
      ).toHaveBeenCalledWith(
        challengeId,
        submissionPhase.id,
        expect.any(Number),
      );
      expect(reviewServiceMockFns.createPendingReview).toHaveBeenCalledTimes(2);
      expect(scheduleSpy).toHaveBeenCalledWith(
        expect.objectContaining({ phaseId: postMortemPhase.id }),
      );
    });
  });

  describe('First2Finish handling', () => {
    it('should open iterative review and assign reviewer when a submission arrives', async () => {
      const challengeId = 'f2f-challenge';
      const iterativePhase = {
        id: 'iter-phase-id',
        phaseId: 'iter-template-id',
        name: 'Iterative Review',
        isOpen: false,
        scheduledStartDate: mockPastPhaseDate,
        scheduledEndDate: mockFuturePhaseDate1,
        actualStartDate: null,
        actualEndDate: null,
        predecessor: null,
      };
      const submissionPhase = {
        ...iterativePhase,
        id: 'submission-phase-id',
        phaseId: 'submission-template',
        name: 'Submission',
      };
      const f2fChallenge = {
        ...mockChallenge,
        id: challengeId,
        type: 'first2finish',
        phases: [iterativePhase, submissionPhase],
        reviewers: [
          {
            id: 'rev-config',
            scorecardId: 'iter-scorecard',
            isMemberReview: true,
            memberReviewerCount: 1,
            phaseId: iterativePhase.phaseId,
            fixedAmount: 0,
            baseCoefficient: null,
            incrementalCoefficient: null,
            type: null,
            aiWorkflowId: null,
          },
        ],
      };

      mockChallengeApiService.getChallengeById.mockResolvedValueOnce(
        f2fChallenge,
      );
      resourcesServiceMockFns.getReviewerResources.mockResolvedValueOnce([
        { id: 'iter-resource' },
      ]);
      reviewServiceMockFns.getAllSubmissionIdsOrdered.mockResolvedValueOnce([
        'submission-1',
      ]);
      reviewServiceMockFns.getExistingReviewPairs.mockResolvedValueOnce(
        new Set(),
      );
      mockChallengeApiService.advancePhase.mockResolvedValueOnce({
        success: true,
        message: 'Phase opened',
        updatedPhases: [
          {
            id: iterativePhase.id,
            name: iterativePhase.name,
            scheduledEndDate: mockFuturePhaseDate2,
            isOpen: true,
            actualStartDate: new Date().toISOString(),
          },
        ],
      });

      await autopilotService.handleFirst2FinishSubmission({
        challengeId,
        submissionId: 'submission-1',
        memberId: 'member-1',
        memberHandle: 'member-1',
        submittedAt: new Date().toISOString(),
      } as First2FinishSubmissionPayload);

      expect(mockChallengeApiService.advancePhase).toHaveBeenCalledWith(
        challengeId,
        iterativePhase.id,
        'open',
      );
      expect(reviewServiceMockFns.createPendingReview).toHaveBeenCalledWith(
        'submission-1',
        'iter-resource',
        iterativePhase.id,
        'iter-scorecard',
        challengeId,
      );
    });

    it('should close iterative review and submission when a passing score is received', async () => {
      const challengeId = 'f2f-challenge-pass';
      const iterativePhase = {
        id: 'iter-phase-id',
        phaseId: 'iter-template-id',
        name: 'Iterative Review',
        isOpen: true,
        scheduledStartDate: mockPastPhaseDate,
        scheduledEndDate: mockFuturePhaseDate1,
        actualStartDate: mockPastPhaseDate,
        actualEndDate: null,
        predecessor: null,
      };
      const submissionPhase = {
        id: 'submission-phase-id',
        phaseId: 'submission-template',
        name: 'Submission',
        isOpen: true,
        scheduledStartDate: mockPastPhaseDate,
        scheduledEndDate: mockFuturePhaseDate2,
        actualStartDate: mockPastPhaseDate,
        actualEndDate: null,
        predecessor: null,
      };
      const f2fChallenge = {
        ...mockChallenge,
        id: challengeId,
        type: 'first2finish',
        phases: [iterativePhase, submissionPhase],
      };

      mockChallengeApiService.getChallengeById.mockResolvedValueOnce(
        f2fChallenge,
      );
      reviewServiceMockFns.getReviewById.mockResolvedValueOnce({
        id: 'review-1',
        phaseId: iterativePhase.id,
        resourceId: 'iter-resource',
        submissionId: 'submission-1',
        scorecardId: 'iter-scorecard',
        score: 95,
        status: 'COMPLETED',
      } as any);
      reviewServiceMockFns.getScorecardPassingScore.mockResolvedValueOnce(80);
      const schedulerAdvanceSpy = jest
        .spyOn(schedulerService, 'advancePhase')
        .mockResolvedValue();

      await autopilotService.handleReviewCompleted({
        challengeId,
        submissionId: 'submission-1',
        reviewId: 'review-1',
        scorecardId: 'iter-scorecard',
        reviewerResourceId: 'iter-resource',
        reviewerHandle: 'iter-reviewer',
        reviewerMemberId: 'iter-member',
        submitterHandle: 'submitter',
        submitterMemberId: 'submitter-id',
        completedAt: new Date().toISOString(),
        initialScore: 95,
      } as ReviewCompletedPayload);

      expect(schedulerAdvanceSpy).toHaveBeenCalledWith(
        expect.objectContaining({ phaseId: iterativePhase.id, state: 'END' }),
      );
      expect(schedulerAdvanceSpy).toHaveBeenCalledWith(
        expect.objectContaining({ phaseId: submissionPhase.id, state: 'END' }),
      );

      schedulerAdvanceSpy.mockRestore();
    });

    it('should assign the next available submission when iterative review fails', async () => {
      const challengeId = 'f2f-challenge-fail';
      const iterativePhase = {
        id: 'iter-phase-id',
        phaseId: 'iter-template-id',
        name: 'Iterative Review',
        isOpen: true,
        scheduledStartDate: mockPastPhaseDate,
        scheduledEndDate: mockFuturePhaseDate1,
        actualStartDate: mockPastPhaseDate,
        actualEndDate: null,
        predecessor: null,
      };
      const f2fChallenge = {
        ...mockChallenge,
        id: challengeId,
        type: 'first2finish',
        phases: [iterativePhase],
        reviewers: [
          {
            id: 'rev-config',
            scorecardId: 'iter-scorecard',
            isMemberReview: true,
            memberReviewerCount: 1,
            phaseId: iterativePhase.phaseId,
            fixedAmount: 0,
            baseCoefficient: null,
            incrementalCoefficient: null,
            type: null,
            aiWorkflowId: null,
          },
        ],
      };

      mockChallengeApiService.getChallengeById
        .mockResolvedValueOnce(f2fChallenge)
        .mockResolvedValueOnce({
          ...f2fChallenge,
          phases: [
            {
              ...iterativePhase,
              isOpen: false,
            },
          ],
        });
      reviewServiceMockFns.getReviewById.mockResolvedValueOnce({
        id: 'review-1',
        phaseId: iterativePhase.id,
        resourceId: 'iter-resource',
        submissionId: 'submission-1',
        scorecardId: 'iter-scorecard',
        score: 40,
        status: 'COMPLETED',
      } as any);
      reviewServiceMockFns.getScorecardPassingScore.mockResolvedValueOnce(80);
      reviewServiceMockFns.getAllSubmissionIdsOrdered
        .mockResolvedValueOnce(['submission-1', 'submission-2'])
        .mockResolvedValueOnce(['submission-1', 'submission-2']);
      reviewServiceMockFns.getExistingReviewPairs
        .mockResolvedValueOnce(new Set())
        .mockResolvedValueOnce(new Set());
      reviewServiceMockFns.getReviewerSubmissionPairs
        .mockResolvedValueOnce(new Set(['iter-resource:submission-1']))
        .mockResolvedValueOnce(new Set(['iter-resource:submission-1']));
      resourcesServiceMockFns.getReviewerResources.mockResolvedValueOnce([
        { id: 'iter-resource' },
      ]);
      const schedulerAdvanceSpy = jest
        .spyOn(schedulerService, 'advancePhase')
        .mockResolvedValue();
      mockChallengeApiService.advancePhase.mockResolvedValueOnce({
        success: true,
        message: 'Phase opened',
        updatedPhases: [
          {
            id: iterativePhase.id,
            name: iterativePhase.name,
            scheduledEndDate: mockFuturePhaseDate2,
            isOpen: true,
            actualStartDate: new Date().toISOString(),
          },
        ],
      });

      await autopilotService.handleReviewCompleted({
        challengeId,
        submissionId: 'submission-1',
        reviewId: 'review-1',
        scorecardId: 'iter-scorecard',
        reviewerResourceId: 'iter-resource',
        reviewerHandle: 'iter-reviewer',
        reviewerMemberId: 'iter-member',
        submitterHandle: 'submitter',
        submitterMemberId: 'submitter-id',
        completedAt: new Date().toISOString(),
        initialScore: 40,
      } as ReviewCompletedPayload);

      expect(reviewServiceMockFns.createPendingReview).toHaveBeenCalledWith(
        'submission-2',
        'iter-resource',
        iterativePhase.id,
        'iter-scorecard',
        challengeId,
      );

      schedulerAdvanceSpy.mockRestore();
    });

    it('should skip previously reviewed submissions when selecting the next iterative review', async () => {
      const challengeId = 'f2f-challenge-history';
      const iterativePhase = {
        id: 'iter-phase-1',
        phaseId: 'iter-template-id',
        name: 'Iterative Review',
        isOpen: true,
        scheduledStartDate: mockPastPhaseDate,
        scheduledEndDate: mockFuturePhaseDate1,
        actualStartDate: mockPastPhaseDate,
        actualEndDate: null,
        predecessor: null,
      };
      const challengeWithOpenPhase = {
        ...mockChallenge,
        id: challengeId,
        type: 'first2finish',
        phases: [iterativePhase],
        reviewers: [
          {
            id: 'rev-config',
            scorecardId: 'iter-scorecard',
            isMemberReview: true,
            memberReviewerCount: 1,
            phaseId: iterativePhase.phaseId,
            basePayment: null,
            incrementalPayment: null,
            type: null,
            aiWorkflowId: null,
          },
        ],
      };
      const challengeAfterClose = {
        ...challengeWithOpenPhase,
        phases: [
          {
            ...iterativePhase,
            isOpen: false,
            actualEndDate: new Date().toISOString(),
          },
        ],
      };
      const nextPhase = {
        id: 'iter-phase-2',
        phaseId: 'iter-template-id',
        name: 'Iterative Review',
        isOpen: true,
        scheduledStartDate: mockFuturePhaseDate1,
        scheduledEndDate: mockFuturePhaseDate2,
        actualStartDate: new Date().toISOString(),
        actualEndDate: null,
        predecessor: iterativePhase.id,
      };

      mockChallengeApiService.getChallengeById
        .mockResolvedValueOnce(challengeWithOpenPhase)
        .mockResolvedValueOnce(challengeAfterClose);
      reviewServiceMockFns.getReviewById.mockResolvedValueOnce({
        id: 'review-2',
        phaseId: iterativePhase.id,
        resourceId: 'iter-resource',
        submissionId: 'submission-2',
        scorecardId: 'iter-scorecard',
        score: 30,
        status: 'COMPLETED',
      } as any);
      reviewServiceMockFns.getScorecardPassingScore.mockResolvedValueOnce(80);
      reviewServiceMockFns.getAllSubmissionIdsOrdered
        .mockResolvedValueOnce([
          'submission-1',
          'submission-2',
          'submission-3',
        ])
        .mockResolvedValueOnce([
          'submission-1',
          'submission-2',
          'submission-3',
        ]);
      reviewServiceMockFns.getExistingReviewPairs
        .mockResolvedValueOnce(new Set())
        .mockResolvedValueOnce(new Set());
      reviewServiceMockFns.getReviewerSubmissionPairs
        .mockResolvedValueOnce(
          new Set([
            'iter-resource:submission-1',
            'iter-resource:submission-2',
          ]),
        )
        .mockResolvedValueOnce(
          new Set([
            'iter-resource:submission-1',
            'iter-resource:submission-2',
          ]),
        );
      resourcesServiceMockFns.getReviewerResources.mockResolvedValueOnce([
        { id: 'iter-resource' },
      ]);
      mockChallengeApiService.createIterativeReviewPhase.mockResolvedValueOnce(
        nextPhase,
      );

      await autopilotService.handleReviewCompleted({
        challengeId,
        submissionId: 'submission-2',
        reviewId: 'review-2',
        scorecardId: 'iter-scorecard',
        reviewerResourceId: 'iter-resource',
        reviewerHandle: 'iter-reviewer',
        reviewerMemberId: 'iter-member',
        submitterHandle: 'submitter',
        submitterMemberId: 'submitter-id',
        completedAt: new Date().toISOString(),
        initialScore: 30,
      } as ReviewCompletedPayload);

      expect(reviewServiceMockFns.createPendingReview).toHaveBeenCalledWith(
        'submission-3',
        'iter-resource',
        nextPhase.id,
        'iter-scorecard',
        challengeId,
      );
    });

    it('should assign the next submission when another pending review exists for the same reviewer', async () => {
      const challengeId = 'f2f-challenge-pending';
      const iterativePhase = {
        id: 'iter-phase-id',
        phaseId: 'iter-template-id',
        name: 'Iterative Review',
        isOpen: true,
        scheduledStartDate: mockPastPhaseDate,
        scheduledEndDate: mockFuturePhaseDate1,
        actualStartDate: mockPastPhaseDate,
        actualEndDate: null,
        predecessor: null,
      };
      const f2fChallenge = {
        ...mockChallenge,
        id: challengeId,
        type: 'first2finish',
        phases: [iterativePhase],
        reviewers: [
          {
            id: 'rev-config',
            scorecardId: 'iter-scorecard',
            isMemberReview: true,
            memberReviewerCount: 1,
            phaseId: iterativePhase.phaseId,
            fixedAmount: 0,
            baseCoefficient: null,
            incrementalCoefficient: null,
            type: null,
            aiWorkflowId: null,
          },
        ],
      };

      mockChallengeApiService.getChallengeById
        .mockResolvedValueOnce(f2fChallenge)
        .mockResolvedValueOnce(f2fChallenge);
      reviewServiceMockFns.getReviewById.mockResolvedValueOnce({
        id: 'review-1',
        phaseId: iterativePhase.id,
        resourceId: 'iter-resource',
        submissionId: 'submission-1',
        scorecardId: 'iter-scorecard',
        score: 40,
        status: 'COMPLETED',
      } as any);
      reviewServiceMockFns.getScorecardPassingScore.mockResolvedValueOnce(80);
      reviewServiceMockFns.getAllSubmissionIdsOrdered.mockResolvedValueOnce([
        'submission-1',
        'submission-2',
      ]);
      reviewServiceMockFns.getExistingReviewPairs.mockResolvedValueOnce(
        new Set(['iter-resource:submission-1']),
      );
      resourcesServiceMockFns.getReviewerResources.mockResolvedValueOnce([
        { id: 'iter-resource' },
      ]);
      const schedulerAdvanceSpy = jest
        .spyOn(schedulerService, 'advancePhase')
        .mockResolvedValue();
      mockChallengeApiService.advancePhase.mockResolvedValueOnce({
        success: true,
        message: 'Phase opened',
        updatedPhases: [
          {
            id: iterativePhase.id,
            name: iterativePhase.name,
            scheduledEndDate: mockFuturePhaseDate2,
            isOpen: true,
            actualStartDate: new Date().toISOString(),
          },
        ],
      });

      await autopilotService.handleReviewCompleted({
        challengeId,
        submissionId: 'submission-1',
        reviewId: 'review-1',
        scorecardId: 'iter-scorecard',
        reviewerResourceId: 'iter-resource',
        reviewerHandle: 'iter-reviewer',
        reviewerMemberId: 'iter-member',
        submitterHandle: 'submitter',
        submitterMemberId: 'submitter-id',
        completedAt: new Date().toISOString(),
        initialScore: 40,
      } as ReviewCompletedPayload);

      expect(reviewServiceMockFns.createPendingReview).toHaveBeenCalledWith(
        'submission-2',
        'iter-resource',
        iterativePhase.id,
        'iter-scorecard',
        challengeId,
      );

      schedulerAdvanceSpy.mockRestore();
    });
  });

  describe('Topgear Task handling', () => {
    it('processes Topgear submissions through the iterative review flow', async () => {
      const challengeId = 'topgear-challenge';
      const iterativePhase = {
        id: 'iter-phase-id',
        phaseId: 'iter-template-id',
        name: 'Iterative Review',
        isOpen: false,
        scheduledStartDate: mockPastPhaseDate,
        scheduledEndDate: mockFuturePhaseDate1,
        actualStartDate: null,
        actualEndDate: null,
        predecessor: null,
      };
      const submissionPhase = {
        ...iterativePhase,
        id: 'topgear-submission-phase-id',
        phaseId: 'topgear-submission-template',
        name: 'Topgear Submission',
      };
      const challenge = {
        ...mockChallenge,
        id: challengeId,
        type: 'Topgear Task',
        phases: [iterativePhase, submissionPhase],
        reviewers: [
          {
            id: 'rev-config',
            scorecardId: 'iter-scorecard',
            isMemberReview: true,
            memberReviewerCount: 1,
            phaseId: iterativePhase.phaseId,
            fixedAmount: 0,
            baseCoefficient: null,
            incrementalCoefficient: null,
            type: null,
            aiWorkflowId: null,
          },
        ],
      };

      mockChallengeApiService.getChallengeById.mockResolvedValueOnce(challenge);
      resourcesServiceMockFns.getReviewerResources.mockResolvedValueOnce([
        { id: 'iter-resource' },
      ]);
      reviewServiceMockFns.getAllSubmissionIdsOrdered.mockResolvedValueOnce([
        'submission-1',
      ]);
      reviewServiceMockFns.getExistingReviewPairs.mockResolvedValueOnce(
        new Set(),
      );
      mockChallengeApiService.advancePhase.mockResolvedValueOnce({
        success: true,
        message: 'Phase opened',
        updatedPhases: [
          {
            id: iterativePhase.id,
            name: iterativePhase.name,
            scheduledEndDate: mockFuturePhaseDate2,
            isOpen: true,
            actualStartDate: new Date().toISOString(),
          },
        ],
      });

      await autopilotService.handleTopgearSubmission({
        challengeId,
        submissionId: 'submission-1',
        memberId: 'member-1',
        memberHandle: 'member-1',
        submittedAt: new Date().toISOString(),
      } as TopgearSubmissionPayload);

      expect(mockChallengeApiService.advancePhase).toHaveBeenCalledWith(
        challengeId,
        iterativePhase.id,
        'open',
      );
      expect(reviewServiceMockFns.createPendingReview).toHaveBeenCalledWith(
        'submission-1',
        'iter-resource',
        iterativePhase.id,
        'iter-scorecard',
        challengeId,
      );
    });

    it('keeps Topgear submission phase open when late and does not create post-mortem review', async () => {
      const challengeId = 'topgear-late-challenge';
      const submissionPhase = {
        id: 'topgear-submission-phase-id',
        phaseId: 'topgear-template',
        name: 'Topgear Submission',
        isOpen: true,
        scheduledStartDate: mockPastPhaseDate,
        scheduledEndDate: mockPastPhaseDate,
        actualStartDate: mockPastPhaseDate,
        actualEndDate: null,
        predecessor: null,
      };
      const postMortemPhase = {
        id: 'post-mortem-phase-id',
        phaseId: 'post-mortem-template',
        name: 'Post-Mortem',
        isOpen: false,
        scheduledStartDate: mockPastPhaseDate,
        scheduledEndDate: mockFuturePhaseDate1,
        actualStartDate: null,
        actualEndDate: null,
        predecessor: submissionPhase.phaseId,
      };
      const topgearChallenge = {
        ...mockChallenge,
        id: challengeId,
        type: 'Topgear Task',
        createdBy: 'creator',
        phases: [submissionPhase, postMortemPhase],
      };

      mockChallengeApiService.getPhaseDetails.mockResolvedValueOnce(
        submissionPhase,
      );
      mockChallengeApiService.getChallengeById.mockResolvedValueOnce(
        topgearChallenge,
      );
      reviewServiceMockFns.getActiveContestSubmissionIds.mockResolvedValueOnce(
        [],
      );

      await schedulerService.advancePhase({
        projectId: topgearChallenge.projectId,
        challengeId,
        phaseId: submissionPhase.id,
        phaseTypeName: submissionPhase.name,
        state: 'END',
        operator: AutopilotOperator.SYSTEM_SCHEDULER,
        projectStatus: topgearChallenge.status,
      });

      expect(mockChallengeApiService.advancePhase).not.toHaveBeenCalled();
      expect(reviewServiceMockFns.createPendingReview).not.toHaveBeenCalled();
    });

    it('keeps Topgear submission phase open when scheduled via system-new-challenge operator', async () => {
      const challengeId = 'topgear-late-new-challenge';
      const submissionPhase = {
        id: 'topgear-submission-phase-id',
        phaseId: 'topgear-template',
        name: 'Topgear Submission',
        isOpen: true,
        scheduledStartDate: mockPastPhaseDate,
        scheduledEndDate: mockPastPhaseDate,
        actualStartDate: mockPastPhaseDate,
        actualEndDate: null,
        predecessor: null,
      };
      const postMortemPhase = {
        id: 'post-mortem-phase-id',
        phaseId: 'post-mortem-template',
        name: 'Post-Mortem',
        isOpen: false,
        scheduledStartDate: mockPastPhaseDate,
        scheduledEndDate: mockFuturePhaseDate1,
        actualStartDate: null,
        actualEndDate: null,
        predecessor: submissionPhase.phaseId,
      };
      const topgearChallenge = {
        ...mockChallenge,
        id: challengeId,
        type: 'Topgear Task',
        createdBy: 'creator',
        phases: [submissionPhase, postMortemPhase],
      };

      mockChallengeApiService.getPhaseDetails.mockResolvedValueOnce(
        submissionPhase,
      );
      mockChallengeApiService.getChallengeById.mockResolvedValueOnce(
        topgearChallenge,
      );
      reviewServiceMockFns.getActiveContestSubmissionIds.mockResolvedValueOnce(
        [],
      );
      resourcesServiceMockFns.getResourceByMemberHandle.mockResolvedValueOnce({
        id: 'creator-resource-id',
        roleName: 'Copilot',
      });
      reviewServiceMockFns.createPendingReview.mockResolvedValueOnce(true);

      await schedulerService.advancePhase({
        projectId: topgearChallenge.projectId,
        challengeId,
        phaseId: submissionPhase.id,
        phaseTypeName: submissionPhase.name,
        state: 'END',
        operator: AutopilotOperator.SYSTEM_NEW_CHALLENGE,
        projectStatus: topgearChallenge.status,
      });

      expect(mockChallengeApiService.advancePhase).not.toHaveBeenCalled();
    });
  });
});
