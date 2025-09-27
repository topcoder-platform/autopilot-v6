import { ChallengeApiService } from './challenge-api.service';
import type { ChallengePrismaService } from './challenge-prisma.service';
import type { AutopilotDbLoggerService } from '../autopilot/services/autopilot-db-logger.service';
import { ChallengeStatusEnum } from '@prisma/client';

describe('ChallengeApiService - advancePhase scheduling', () => {
  const fixedNow = new Date('2025-09-27T06:00:00.000Z');
  const futureStart = new Date('2025-09-27T07:00:00.000Z');
  const phaseDurationSeconds = 7200;
  const futureEnd = new Date(futureStart.getTime() + phaseDurationSeconds * 1000);

  let prisma: jest.Mocked<ChallengePrismaService>;
  let dbLogger: jest.Mocked<AutopilotDbLoggerService>;
  let challengePhaseUpdate: jest.Mock;
  let challengeUpdate: jest.Mock;
  let challengeFindUnique: jest.Mock;
  let service: ChallengeApiService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(fixedNow);

    challengePhaseUpdate = jest.fn().mockResolvedValue(undefined);
    challengeUpdate = jest.fn().mockResolvedValue(undefined);

    challengeFindUnique = jest.fn();

    prisma = {
      challenge: {
        findUnique: challengeFindUnique,
      },
      challengePhase: {
        update: challengePhaseUpdate,
      },
      $transaction: jest.fn(),
    } as unknown as jest.Mocked<ChallengePrismaService>;

    prisma.$transaction.mockImplementation(async (cb) => {
      await cb({
        challengePhase: { update: challengePhaseUpdate },
        challenge: { update: challengeUpdate },
      } as unknown as ChallengePrismaService);
    });

    dbLogger = {
      logAction: jest.fn(),
    } as unknown as jest.Mocked<AutopilotDbLoggerService>;

    service = new ChallengeApiService(prisma, dbLogger);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('pulls forward the scheduled dates when opening a phase early', async () => {
    const reviewPhase = {
      id: 'phase-1',
      phaseId: 'template-1',
      name: 'Review',
      description: null,
      isOpen: false,
      predecessor: null,
      duration: phaseDurationSeconds,
      scheduledStartDate: futureStart,
      scheduledEndDate: futureEnd,
      actualStartDate: null,
      actualEndDate: null,
      constraints: [],
      createdAt: fixedNow,
      createdBy: 'tester',
      updatedAt: fixedNow,
      updatedBy: 'tester',
    };

    const appealsPhase = {
      id: 'phase-2',
      phaseId: 'template-2',
      name: 'Appeals',
      description: null,
      isOpen: false,
      predecessor: reviewPhase.phaseId,
      duration: 3600,
      scheduledStartDate: new Date(futureEnd.getTime()),
      scheduledEndDate: new Date(futureEnd.getTime() + 3600 * 1000),
      actualStartDate: null,
      actualEndDate: null,
      constraints: [],
      createdAt: fixedNow,
      createdBy: 'tester',
      updatedAt: fixedNow,
      updatedBy: 'tester',
    };

    const challengeRecord = {
      id: 'challenge-1',
      name: 'Test Challenge',
      description: null,
      descriptionFormat: 'markdown',
      projectId: 123,
      typeId: 'type-1',
      trackId: 'track-1',
      timelineTemplateId: 'timeline-1',
      currentPhaseNames: [],
      tags: [],
      groups: [],
      submissionStartDate: fixedNow,
      submissionEndDate: fixedNow,
      registrationStartDate: fixedNow,
      registrationEndDate: fixedNow,
      startDate: fixedNow,
      endDate: null,
      legacyId: null,
      status: ChallengeStatusEnum.ACTIVE,
      createdBy: 'tester',
      updatedBy: 'tester',
      metadata: [],
      phases: [reviewPhase, appealsPhase],
      reviewers: [],
      winners: [],
      track: { name: 'DEVELOP' },
      type: { name: 'Standard' },
      legacyRecord: null,
      discussions: [],
      events: [],
      prizeSets: [],
      terms: [],
      skills: [],
      attachments: [],
      overview: {},
      numOfSubmissions: 0,
      numOfCheckpointSubmissions: 0,
      numOfRegistrants: 0,
      createdAt: fixedNow,
    };

    challengeFindUnique
      .mockResolvedValueOnce(challengeRecord as any)
      .mockResolvedValueOnce(challengeRecord as any);

    await service.advancePhase('challenge-1', 'phase-1', 'open');

    expect(challengeFindUnique).toHaveBeenCalled();
    expect(challengePhaseUpdate).toHaveBeenCalledWith({
      where: { id: reviewPhase.id },
      data: expect.objectContaining({
        scheduledStartDate: fixedNow,
        scheduledEndDate: new Date(fixedNow.getTime() + phaseDurationSeconds * 1000),
        duration: phaseDurationSeconds,
      }),
    });
  });
});
