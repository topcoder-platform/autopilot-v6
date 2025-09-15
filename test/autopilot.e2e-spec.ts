import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
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
} from '../src/autopilot/interfaces/autopilot.interface';
import { AutopilotService } from '../src/autopilot/services/autopilot.service';

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
  let challengeApiService: ChallengeApiService;
  let autopilotConsumer: AutopilotConsumer;
  let recoveryService: RecoveryService;
  let autopilotService: AutopilotService;

  const mockKafkaProduce = jest.fn().mockResolvedValue(null);
  const mockGetAllActiveChallenges = jest.fn();
  const mockGetChallenge = jest.fn();
  const mockGetActiveChallenge = jest.fn(); // Mock for the new method

  beforeEach(async () => {
    mockKafkaProduce.mockClear();
    mockGetAllActiveChallenges.mockClear();
    mockGetChallenge.mockClear();
    mockGetActiveChallenge.mockClear();

    // Corrected: Provide a default mock implementation before the module compiles
    mockGetAllActiveChallenges.mockResolvedValue([]);

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
      .useValue({
        getAllActiveChallenges: mockGetAllActiveChallenges,
        getChallenge: mockGetChallenge,
        getChallengeById: mockGetActiveChallenge, // Add the new method to the mock
        getPhaseDetails: jest.fn().mockImplementation((challengeId, phaseId) => {
          // Return mock phase details based on phaseId
          const phase = mockChallenge.phases.find(p => p.id === phaseId);
          if (phase) {
            return Promise.resolve(phase);
          }
          // Default mock for test phases
          return Promise.resolve({
            id: phaseId,
            name: 'Test Phase',
            isOpen: true, // Default to open for most tests
            scheduledStartDate: mockPastPhaseDate,
            scheduledEndDate: mockFuturePhaseDate1,
          });
        }),
        advancePhase: jest.fn().mockImplementation((challengeId, phaseId, operation) => {
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
                  }
                ]
              }
            });
          } else if (operation === 'open') {
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
                }
              ]
            });
          }
          return Promise.resolve({ success: false, message: 'Unknown operation' });
        }),
      })
      .compile();

    app = moduleFixture.createNestApplication();

    schedulerService = app.get<SchedulerService>(SchedulerService);
    challengeApiService = app.get<ChallengeApiService>(ChallengeApiService);
    autopilotConsumer = app.get<AutopilotConsumer>(AutopilotConsumer);
    recoveryService = app.get<RecoveryService>(RecoveryService);
    autopilotService = app.get<AutopilotService>(AutopilotService);

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
      return request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('ok');
        });
    });
  });

  describe('Challenge Creation and Scheduling', () => {
    it('should schedule only the next phase when a challenge.notification.create event is received', async () => {
      mockGetActiveChallenge.mockResolvedValue(mockChallenge); // Use the correct mocked method
      const scheduleSpy = jest.spyOn(
        schedulerService,
        'schedulePhaseTransition',
      );

      await autopilotConsumer.topicHandlers[KAFKA_TOPICS.CHALLENGE_CREATED]({
        challengeId: mockChallenge.id,
        projectId: mockChallenge.projectId,
        status: 'ACTIVE',
        operator: AutopilotOperator.SYSTEM,
      } as ChallengeUpdatePayload);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(challengeApiService.getChallengeById).toHaveBeenCalledWith(
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
          },
        ],
      };
      
      mockGetActiveChallenge.mockResolvedValue(challengeWithNoOpenPhases);
      const scheduleSpy = jest.spyOn(
        schedulerService,
        'schedulePhaseTransition',
      );

      await autopilotConsumer.topicHandlers[KAFKA_TOPICS.CHALLENGE_CREATED]({
        challengeId: challengeWithNoOpenPhases.id,
        projectId: challengeWithNoOpenPhases.projectId,
        status: 'ACTIVE',
        operator: AutopilotOperator.SYSTEM,
      } as ChallengeUpdatePayload);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(challengeApiService.getChallengeById).toHaveBeenCalledWith(
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
      mockGetActiveChallenge.mockResolvedValue(updatedChallenge); // Use the correct mocked method
      const rescheduleSpy = jest.spyOn(
        app.get(AutopilotService),
        'reschedulePhaseTransition',
      );

      await autopilotConsumer.topicHandlers[KAFKA_TOPICS.CHALLENGE_UPDATE]({
        challengeId: updatedChallenge.id,
        projectId: updatedChallenge.projectId,
        status: 'ACTIVE',
        operator: AutopilotOperator.SYSTEM,
      } as ChallengeUpdatePayload);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(challengeApiService.getChallengeById).toHaveBeenCalledWith(
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
      schedulerService.schedulePhaseTransition({
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
        app.get(AutopilotService),
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
      mockGetAllActiveChallenges.mockResolvedValue([
        mockChallengeWithPastPhase,
      ]);
      const scheduleSpy = jest.spyOn(
        schedulerService,
        'schedulePhaseTransition',
      );
      const triggerEventSpy = jest.spyOn(schedulerService, 'triggerKafkaEvent');

      await recoveryService.onApplicationBootstrap();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(challengeApiService.getAllActiveChallenges).toHaveBeenCalled();
      // Should only trigger the overdue phase, not schedule future ones
      expect(scheduleSpy).toHaveBeenCalledTimes(0);
      expect(triggerEventSpy).toHaveBeenCalledTimes(1);

      expect(triggerEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: mockChallengeWithPastPhase.phases[0].id, // The overdue phase
        }),
      );
    });

    it('should schedule future phases when no overdue phases exist', async () => {
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
          },
        ],
      };
      
      mockGetAllActiveChallenges.mockResolvedValue([challengeWithFuturePhase]);
      const scheduleSpy = jest.spyOn(
        schedulerService,
        'schedulePhaseTransition',
      );
      const triggerEventSpy = jest.spyOn(schedulerService, 'triggerKafkaEvent');

      await recoveryService.onApplicationBootstrap();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(challengeApiService.getAllActiveChallenges).toHaveBeenCalled();
      expect(scheduleSpy).toHaveBeenCalledTimes(1);
      expect(triggerEventSpy).toHaveBeenCalledTimes(0);

      expect(scheduleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: challengeWithFuturePhase.phases[1].id, // The next ready phase
        }),
      );
    });

    it('should open and schedule next phases in the chain when a phase completes', async () => {
      const scheduleSpy = jest.spyOn(
        schedulerService,
        'schedulePhaseTransition',
      );
      const openAndScheduleNextPhasesSpy = jest.spyOn(
        autopilotService,
        'openAndScheduleNextPhases',
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

      expect(challengeApiService.advancePhase).toHaveBeenCalledWith(
        mockChallenge.id,
        mockChallenge.phases[0].id,
        'close',
      );
      
      // Should open and schedule the next phase in the chain
      expect(openAndScheduleNextPhasesSpy).toHaveBeenCalledWith(
        mockChallenge.id,
        mockChallenge.projectId,
        'ACTIVE',
        expect.arrayContaining([
          expect.objectContaining({
            id: 'p2a3b4c5-d6e7-f8a9-b0c1-d2e3f4a5b6c7',
            name: 'Submission',
          })
        ])
      );
    });

    it('should handle complete phase chain flow from challenge creation to phase completion', async () => {
      mockGetActiveChallenge.mockResolvedValue(mockChallenge);
      const scheduleSpy = jest.spyOn(
        schedulerService,
        'schedulePhaseTransition',
      );

      // 1. Create a new challenge - should schedule only the first phase
      await autopilotConsumer.topicHandlers[KAFKA_TOPICS.CHALLENGE_CREATED]({
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
      expect(challengeApiService.advancePhase).toHaveBeenCalledWith(
        mockChallenge.id,
        mockChallenge.phases[0].id,
        'close',
      );

      // Should have opened the next phase first, then scheduled it for closure
      expect(challengeApiService.advancePhase).toHaveBeenCalledWith(
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
      const advancePhaseCallOrder: Array<{ operation: string; phaseId: string }> = [];
      
      // Track the order of advancePhase calls
      const mockAdvancePhase = jest.fn().mockImplementation((challengeId, phaseId, operation) => {
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
                }
              ]
            }
          });
        } else if (operation === 'open') {
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
              }
            ]
          });
        }
        return Promise.resolve({ success: false, message: 'Unknown operation' });
      });

      challengeApiService.advancePhase = mockAdvancePhase;

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
        phaseId: 'current-phase-id'
      });
      expect(advancePhaseCallOrder[1]).toEqual({
        operation: 'open',
        phaseId: 'next-phase-id'
      });
    });

    it('should not try to close phases that are already closed', async () => {
      // Mock a closed phase
      const mockGetPhaseDetails = jest.fn().mockResolvedValue({
        id: 'closed-phase-id',
        name: 'Closed Phase',
        isOpen: false, // This phase is already closed
        scheduledEndDate: mockFuturePhaseDate1,
      });

      challengeApiService.getPhaseDetails = mockGetPhaseDetails;
      
      const mockAdvancePhase = jest.fn();
      challengeApiService.advancePhase = mockAdvancePhase;

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
      expect(mockAdvancePhase).not.toHaveBeenCalled();
    });

    it('should not try to open phases that are already open', async () => {
      // Mock an open phase
      const mockGetPhaseDetails = jest.fn().mockResolvedValue({
        id: 'open-phase-id',
        name: 'Open Phase',
        isOpen: true, // This phase is already open
        scheduledStartDate: mockPastPhaseDate,
      });

      challengeApiService.getPhaseDetails = mockGetPhaseDetails;
      
      const mockAdvancePhase = jest.fn();
      challengeApiService.advancePhase = mockAdvancePhase;

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
      expect(mockAdvancePhase).not.toHaveBeenCalled();
    });
  });
});
