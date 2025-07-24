import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { KafkaService } from '../src/kafka/kafka.service';
import { SchedulerService } from '../src/autopilot/services/scheduler.service';
import { ChallengeApiService } from '../src/challenge/challenge-api.service';
import { KAFKA_TOPICS } from '../src/kafka/constants/topics';
import { AutopilotConsumer } from '../src/kafka/consumers/autopilot.consumer';
import { RecoveryService } from '../src/recovery/recovery.service';
import { ChallengeUpdatePayload } from 'src/autopilot/interfaces/autopilot.interface';
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
      name: 'Registration',
      scheduledEndDate: mockFuturePhaseDate1,
    },
    {
      id: 'p2a3b4c5-d6e7-f8a9-b0c1-d2e3f4a5b6c7',
      name: 'Submission',
      scheduledEndDate: mockFuturePhaseDate2,
    },
  ],
};

const mockChallengeWithPastPhase = {
  ...mockChallenge,
  phases: [
    { ...mockChallenge.phases[0], scheduledEndDate: mockPastPhaseDate }, // This one is overdue
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
      .overrideProvider(ChallengeApiService)
      .useValue({
        getAllActiveChallenges: mockGetAllActiveChallenges,
        getChallenge: mockGetChallenge,
        getActiveChallenge: mockGetActiveChallenge, // Add the new method to the mock
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
    it('should schedule phases when a challenge.notification.create event is received', async () => {
      mockGetActiveChallenge.mockResolvedValue(mockChallenge); // Use the correct mocked method
      const scheduleSpy = jest.spyOn(
        schedulerService,
        'schedulePhaseTransition',
      );

      await autopilotConsumer.topicHandlers[KAFKA_TOPICS.CHALLENGE_CREATED]({
        challengeId: mockChallenge.id,
        projectId: mockChallenge.projectId,
        status: 'ACTIVE',
        operator: 'system',
      } as ChallengeUpdatePayload);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(challengeApiService.getActiveChallenge).toHaveBeenCalledWith(
        mockChallenge.id,
      );
      expect(scheduleSpy).toHaveBeenCalledTimes(2);
      expect(scheduleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: mockChallenge.phases[0].id,
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
        operator: 'system',
      } as ChallengeUpdatePayload);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(challengeApiService.getActiveChallenge).toHaveBeenCalledWith(
        updatedChallenge.id,
      );
      expect(rescheduleSpy).toHaveBeenCalledTimes(1);
      expect(rescheduleSpy).toHaveBeenCalledWith(
        updatedChallenge.projectId,
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
        operator: 'system',
        projectStatus: 'ACTIVE',
      });

      const autopilotCancelSpy = jest.spyOn(
        app.get(AutopilotService),
        'cancelPhaseTransition',
      );

      await autopilotConsumer.topicHandlers[KAFKA_TOPICS.COMMAND]({
        command: 'cancel_schedule',
        projectId: mockChallenge.projectId,
        phaseId: mockChallenge.phases[0].id,
        operator: 'admin',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(autopilotCancelSpy).toHaveBeenCalledWith(
        mockChallenge.projectId,
        mockChallenge.phases[0].id,
      );
    });
  });

  describe('Recovery Service', () => {
    it('should schedule future phases and immediately trigger overdue phases on bootstrap', async () => {
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
      expect(scheduleSpy).toHaveBeenCalledTimes(1);
      expect(triggerEventSpy).toHaveBeenCalledTimes(1);

      expect(scheduleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: mockChallengeWithPastPhase.phases[1].id,
        }),
      );
      expect(triggerEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          phaseId: mockChallengeWithPastPhase.phases[0].id,
        }),
      );
    });
  });
});
