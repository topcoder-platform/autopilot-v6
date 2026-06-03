import { ChallengeApiService } from './challenge-api.service';
import type { ChallengePrismaService } from './challenge-prisma.service';
import type { AutopilotDbLoggerService } from '../autopilot/services/autopilot-db-logger.service';
import { ChallengeStatusEnum, PrizeSetTypeEnum } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';

describe('ChallengeApiService - advancePhase scheduling', () => {
  const fixedNow = new Date('2025-09-27T06:00:00.000Z');
  const futureStart = new Date('2025-09-27T07:00:00.000Z');
  const phaseDurationSeconds = 7200;
  const futureEnd = new Date(
    futureStart.getTime() + phaseDurationSeconds * 1000,
  );

  let prisma: jest.Mocked<ChallengePrismaService>;
  let dbLogger: jest.Mocked<AutopilotDbLoggerService>;
  let challengePhaseUpdate: jest.Mock;
  let challengePhaseCreate: jest.Mock;
  let challengePhaseDeleteMany: jest.Mock;
  let challengePhaseUpdateMany: jest.Mock;
  let challengePhaseFindMany: jest.Mock;
  let challengeUpdate: jest.Mock;
  let challengeFindUnique: jest.Mock;
  let txChallengeFindUnique: jest.Mock;
  let txPhaseFindFirst: jest.Mock;
  let txQueryRaw: jest.Mock;
  let service: ChallengeApiService;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(fixedNow);

    challengePhaseUpdate = jest.fn().mockResolvedValue(undefined);
    challengePhaseCreate = jest.fn().mockResolvedValue({ id: 'new-phase' });
    challengePhaseDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
    challengePhaseUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    challengePhaseFindMany = jest.fn().mockResolvedValue([]);
    challengeUpdate = jest.fn().mockResolvedValue(undefined);

    challengeFindUnique = jest.fn();
    txChallengeFindUnique = jest.fn();
    txPhaseFindFirst = jest.fn();
    txQueryRaw = jest.fn().mockResolvedValue(undefined);

    prisma = {
      challenge: {
        findUnique: challengeFindUnique,
      },
      challengePhase: {
        update: challengePhaseUpdate,
        updateMany: challengePhaseUpdateMany,
        create: challengePhaseCreate,
        deleteMany: challengePhaseDeleteMany,
        findMany: challengePhaseFindMany,
      },
      $transaction: jest.fn(),
    } as unknown as jest.Mocked<ChallengePrismaService>;

    prisma.$transaction.mockImplementation(async (cb) => {
      return cb({
        $queryRaw: txQueryRaw,
        challenge: {
          findUnique: txChallengeFindUnique,
          update: challengeUpdate,
        },
        phase: {
          findFirst: txPhaseFindFirst,
        },
        challengePhase: {
          update: challengePhaseUpdate,
          updateMany: challengePhaseUpdateMany,
          create: challengePhaseCreate,
          deleteMany: challengePhaseDeleteMany,
          findMany: challengePhaseFindMany,
        },
      } as unknown as ChallengePrismaService);
    });

    dbLogger = {
      logAction: jest.fn(),
    } as unknown as jest.Mocked<AutopilotDbLoggerService>;

    configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<ConfigService>;

    service = new ChallengeApiService(prisma, dbLogger, configService);
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
      metadata: {},
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

    const rescheduleSpy = jest.spyOn(service, 'rescheduleSuccessorPhases');

    await service.advancePhase('challenge-1', 'phase-1', 'open');

    expect(challengeFindUnique).toHaveBeenCalled();
    expect(rescheduleSpy).toHaveBeenCalledWith('challenge-1', reviewPhase.id);
    expect(challengePhaseUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: reviewPhase.id,
          isOpen: false,
        }),
        data: expect.objectContaining({
          isOpen: true,
          scheduledStartDate: fixedNow,
          scheduledEndDate: new Date(
            fixedNow.getTime() + phaseDurationSeconds * 1000,
          ),
          duration: phaseDurationSeconds,
        }),
      }),
    );
  });

  it('extends the appeals phase duration when opening late', async () => {
    const lateNow = new Date('2025-09-27T09:30:00.000Z');
    jest.setSystemTime(lateNow);

    const appealsPhase = {
      id: 'appeals-phase',
      phaseId: 'template-appeals',
      name: 'Appeals',
      description: null,
      isOpen: false,
      predecessor: 'review-template',
      duration: 3600,
      scheduledStartDate: new Date('2025-09-27T08:30:00.000Z'),
      scheduledEndDate: new Date('2025-09-27T09:30:00.000Z'),
      actualStartDate: null,
      actualEndDate: null,
      constraints: [],
      createdAt: lateNow,
      createdBy: 'tester',
      updatedAt: lateNow,
      updatedBy: 'tester',
    };

    const challengeRecord = {
      id: 'challenge-appeals',
      name: 'Appeals Challenge',
      description: null,
      descriptionFormat: 'markdown',
      projectId: 456,
      typeId: 'type-appeals',
      trackId: 'track-appeals',
      timelineTemplateId: 'timeline-appeals',
      currentPhaseNames: [],
      tags: [],
      groups: [],
      submissionStartDate: lateNow,
      submissionEndDate: lateNow,
      registrationStartDate: lateNow,
      registrationEndDate: lateNow,
      startDate: lateNow,
      endDate: null,
      legacyId: null,
      status: ChallengeStatusEnum.ACTIVE,
      createdBy: 'tester',
      updatedBy: 'tester',
      metadata: {},
      phases: [appealsPhase],
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
      createdAt: lateNow,
    };

    challengeFindUnique
      .mockResolvedValueOnce(challengeRecord as any)
      .mockResolvedValueOnce(challengeRecord as any);

    await service.advancePhase('challenge-appeals', 'appeals-phase', 'open');

    expect(challengePhaseUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: appealsPhase.id,
          isOpen: false,
        }),
        data: expect.objectContaining({
          isOpen: true,
          scheduledStartDate: lateNow,
          scheduledEndDate: new Date(lateNow.getTime() + 3600 * 1000),
          duration: appealsPhase.duration,
        }),
      }),
    );
  });

  it('extends a non-appeals phase opened late when remaining time is shorter than the configured duration', async () => {
    const lateNow = new Date('2025-09-27T10:00:00.000Z');
    jest.setSystemTime(lateNow);

    const submissionPhase = {
      id: 'phase-submission',
      phaseId: 'template-submission',
      name: 'Submission',
      description: null,
      isOpen: false,
      predecessor: null,
      duration: 7200,
      scheduledStartDate: new Date('2025-09-27T06:00:00.000Z'),
      scheduledEndDate: new Date('2025-09-27T10:05:00.000Z'),
      actualStartDate: null,
      actualEndDate: null,
      constraints: [],
      createdAt: lateNow,
      createdBy: 'tester',
      updatedAt: lateNow,
      updatedBy: 'tester',
    };

    const challengeRecord = {
      id: 'challenge-late-phase',
      name: 'Late Phase Challenge',
      description: null,
      descriptionFormat: 'markdown',
      projectId: 789,
      typeId: 'type-late',
      trackId: 'track-late',
      timelineTemplateId: 'timeline-late',
      currentPhaseNames: [],
      tags: [],
      groups: [],
      submissionStartDate: lateNow,
      submissionEndDate: lateNow,
      registrationStartDate: lateNow,
      registrationEndDate: lateNow,
      startDate: lateNow,
      endDate: null,
      legacyId: null,
      status: ChallengeStatusEnum.ACTIVE,
      createdBy: 'tester',
      updatedBy: 'tester',
      metadata: {},
      phases: [submissionPhase],
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
      createdAt: lateNow,
    };

    challengeFindUnique
      .mockResolvedValueOnce(challengeRecord as any)
      .mockResolvedValueOnce(challengeRecord as any);

    await service.advancePhase(
      'challenge-late-phase',
      submissionPhase.id,
      'open',
    );

    expect(challengePhaseUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: submissionPhase.id,
          isOpen: false,
        }),
        data: expect.objectContaining({
          isOpen: true,
          scheduledStartDate: lateNow,
          scheduledEndDate: new Date(
            lateNow.getTime() + submissionPhase.duration * 1000,
          ),
          duration: submissionPhase.duration,
        }),
      }),
    );
  });

  describe('createPostMortemPhase', () => {
    const buildPhase = (overrides: Partial<any> = {}) => {
      const scheduledStart = new Date('2025-09-26T00:00:00.000Z');
      return {
        id: 'phase-default',
        phaseId: 'template-default',
        name: 'Generic Phase',
        description: null,
        isOpen: false,
        predecessor: null,
        duration: 3600,
        scheduledStartDate: scheduledStart,
        scheduledEndDate: new Date(scheduledStart.getTime() + 3600 * 1000),
        actualStartDate: null,
        actualEndDate: null,
        constraints: [],
        ...overrides,
      };
    };

    it('reuses an existing Post-Mortem phase when one already exists after submission', async () => {
      const challengeId = 'challenge-reuse';
      const registrationPhase = buildPhase({
        id: 'phase-registration',
        phaseId: 'template-registration',
        name: 'Registration',
      });
      const submissionPhase = buildPhase({
        id: 'phase-submission',
        phaseId: 'template-submission',
        name: 'Submission',
        isOpen: true,
      });
      const reviewPhase = buildPhase({
        id: 'phase-review',
        phaseId: 'template-review',
        name: 'Review',
      });
      const existingPostMortem = buildPhase({
        id: 'phase-postmortem',
        phaseId: 'template-postmortem',
        name: 'Post-Mortem',
        scheduledStartDate: new Date('2025-09-28T00:00:00.000Z'),
        scheduledEndDate: new Date('2025-09-30T00:00:00.000Z'),
        actualStartDate: null,
        actualEndDate: new Date('2025-09-29T00:00:00.000Z'),
        isOpen: false,
      });

      txChallengeFindUnique.mockResolvedValueOnce({
        id: challengeId,
        phases: [
          registrationPhase,
          submissionPhase,
          reviewPhase,
          existingPostMortem,
        ],
        currentPhaseNames: [],
      } as any);

      challengeFindUnique.mockResolvedValueOnce({
        id: challengeId,
        phases: [
          registrationPhase,
          submissionPhase,
          {
            ...existingPostMortem,
            scheduledStartDate: fixedNow,
            scheduledEndDate: new Date(
              fixedNow.getTime() + 72 * 60 * 60 * 1000,
            ),
            actualStartDate: fixedNow,
            actualEndDate: null,
            isOpen: true,
          },
        ],
      } as any);

      const result = await service.createPostMortemPhase(
        challengeId,
        submissionPhase.id,
        72,
      );

      expect(txQueryRaw).toHaveBeenCalledTimes(1);
      expect(challengePhaseDeleteMany).toHaveBeenCalledWith({
        where: { id: { in: [reviewPhase.id] } },
      });
      expect(challengePhaseUpdate).toHaveBeenCalledWith({
        where: { id: existingPostMortem.id },
        data: expect.objectContaining({
          predecessor: submissionPhase.phaseId,
          isOpen: true,
          actualEndDate: null,
        }),
      });
      const reopenArgs = challengePhaseUpdate.mock.calls[0][0].data;
      expect(reopenArgs.actualStartDate).toBeInstanceOf(Date);
      expect(reopenArgs.actualStartDate?.toISOString()).toBe(
        fixedNow.toISOString(),
      );
      expect(reopenArgs.duration).toBe(72 * 60 * 60);
      expect(challengePhaseCreate).not.toHaveBeenCalled();
      expect(txPhaseFindFirst).not.toHaveBeenCalled();
      expect(challengeUpdate).toHaveBeenCalledWith({
        where: { id: challengeId },
        data: { currentPhaseNames: [existingPostMortem.name] },
      });
      expect(result.id).toBe(existingPostMortem.id);
      expect(dbLogger.logAction).toHaveBeenLastCalledWith(
        'challenge.createPostMortemPhase',
        expect.objectContaining({
          status: 'SUCCESS',
          details: expect.objectContaining({
            reusedExisting: true,
            postMortemPhaseId: existingPostMortem.id,
          }),
        }),
      );
    });

    it('creates a new Post-Mortem phase when none exists after submission', async () => {
      const challengeId = 'challenge-new';
      const submissionPhase = buildPhase({
        id: 'phase-submission',
        phaseId: 'template-submission',
        name: 'Submission',
      });
      const iterativeReviewPhase = buildPhase({
        id: 'phase-iterative',
        phaseId: 'template-iterative',
        name: 'Iterative Review',
      });

      const postMortemPhaseType = {
        id: 'template-postmortem',
        name: 'Post-Mortem',
        description: 'Post-Mortem phase',
      };

      txChallengeFindUnique.mockResolvedValueOnce({
        id: challengeId,
        phases: [submissionPhase, iterativeReviewPhase],
        currentPhaseNames: [],
      } as any);
      txPhaseFindFirst.mockResolvedValueOnce(postMortemPhaseType as any);

      const createdPostMortem = {
        id: 'phase-postmortem',
      };
      challengePhaseCreate.mockResolvedValueOnce(createdPostMortem as any);

      challengeFindUnique.mockResolvedValueOnce({
        id: challengeId,
        phases: [
          submissionPhase,
          {
            ...createdPostMortem,
            phaseId: postMortemPhaseType.id,
            name: postMortemPhaseType.name,
            description: postMortemPhaseType.description,
            isOpen: true,
            duration: 72 * 60 * 60,
            scheduledStartDate: fixedNow,
            scheduledEndDate: new Date(
              fixedNow.getTime() + 72 * 60 * 60 * 1000,
            ),
            actualStartDate: fixedNow,
            actualEndDate: null,
            predecessor: submissionPhase.phaseId,
            constraints: [],
          },
        ],
      } as any);

      const result = await service.createPostMortemPhase(
        challengeId,
        submissionPhase.id,
        72,
      );

      expect(challengePhaseDeleteMany).toHaveBeenCalledWith({
        where: { id: { in: [iterativeReviewPhase.id] } },
      });
      expect(txPhaseFindFirst).toHaveBeenCalledWith({
        where: { name: { in: expect.arrayContaining(['Post-Mortem']) } },
      });
      expect(challengePhaseCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          challengeId,
          phaseId: postMortemPhaseType.id,
          name: postMortemPhaseType.name,
          predecessor: submissionPhase.phaseId,
        }),
      });
      const createArgs = challengePhaseCreate.mock.calls[0][0].data;
      expect(createArgs.scheduledStartDate).toBeInstanceOf(Date);
      expect(createArgs.isOpen).toBe(true);
      expect(createArgs.duration).toBe(72 * 60 * 60);
      expect(challengePhaseUpdate).not.toHaveBeenCalled();
      expect(challengeUpdate).toHaveBeenCalledWith({
        where: { id: challengeId },
        data: { currentPhaseNames: [postMortemPhaseType.name] },
      });
      expect(result.id).toBe(createdPostMortem.id);
      expect(dbLogger.logAction).toHaveBeenLastCalledWith(
        'challenge.createPostMortemPhase',
        expect.objectContaining({
          status: 'SUCCESS',
          details: expect.objectContaining({
            reusedExisting: false,
            postMortemPhaseId: createdPostMortem.id,
          }),
        }),
      );
    });
  });

  describe('AI Review phase closure blocking', () => {
    const buildAiReviewChallenge = (phaseIsOpen: boolean) => ({
      id: 'challenge-ai-review',
      name: 'AI Review Challenge',
      description: null,
      descriptionFormat: 'markdown',
      projectId: 789,
      typeId: 'type-ai',
      trackId: 'track-ai',
      timelineTemplateId: 'timeline-ai',
      currentPhaseNames: phaseIsOpen ? ['AI Review'] : [],
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
      metadata: {},
      phases: [
        {
          id: 'ai-review-phase',
          phaseId: 'template-ai-review',
          name: 'AI Review',
          description: null,
          isOpen: phaseIsOpen,
          predecessor: null,
          duration: 7200,
          scheduledStartDate: fixedNow,
          scheduledEndDate: new Date(fixedNow.getTime() + 7200 * 1000),
          actualStartDate: phaseIsOpen ? fixedNow : null,
          actualEndDate: null,
          constraints: [],
          createdAt: fixedNow,
          createdBy: 'tester',
          updatedAt: fixedNow,
          updatedBy: 'tester',
        },
      ],
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
      numOfSubmissions: 1,
      numOfCheckpointSubmissions: 0,
      numOfRegistrants: 1,
      createdAt: fixedNow,
    });

    it('blocks closing AI Review phase when pending AI decisions exist', async () => {
      const challengeRecord = buildAiReviewChallenge(true);
      challengeFindUnique.mockResolvedValueOnce(challengeRecord as any);

      // Mock pending AI decisions count query
      prisma.$queryRaw = jest.fn().mockResolvedValueOnce([{ count: 3 }]);

      const result = await service.advancePhase(
        'challenge-ai-review',
        'ai-review-phase',
        'close',
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Cannot close AI Review phase');
      expect(result.message).toContain('3 pending AI decision(s)');
      expect(dbLogger.logAction).toHaveBeenCalledWith(
        'challenge.advancePhase',
        expect.objectContaining({
          status: 'INFO',
          details: expect.objectContaining({
            pendingAiDecisions: 3,
          }),
        }),
      );
    });

    it('allows closing AI Review phase when no pending AI decisions', async () => {
      const challengeRecord = buildAiReviewChallenge(true);
      challengeFindUnique
        .mockResolvedValueOnce(challengeRecord as any)
        .mockResolvedValueOnce(challengeRecord as any);

      // Mock no pending AI decisions
      prisma.$queryRaw = jest.fn().mockResolvedValueOnce([{ count: 0 }]);

      const result = await service.advancePhase(
        'challenge-ai-review',
        'ai-review-phase',
        'close',
      );

      expect(result.success).toBe(true);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('does not check pending AI decisions when opening AI Review phase', async () => {
      const challengeRecord = buildAiReviewChallenge(false);
      challengeFindUnique
        .mockResolvedValueOnce(challengeRecord as any)
        .mockResolvedValueOnce(challengeRecord as any);

      const queryRawSpy = jest.fn();
      prisma.$queryRaw = queryRawSpy;

      await service.advancePhase(
        'challenge-ai-review',
        'ai-review-phase',
        'open',
      );

      // Should not call $queryRaw for pending AI decisions when opening
      expect(queryRawSpy).not.toHaveBeenCalled();
    });

    it('does not check pending AI decisions for non-AI Review phases', async () => {
      const reviewPhase = {
        id: 'regular-review-phase',
        phaseId: 'template-review',
        name: 'Review',
        description: null,
        isOpen: true,
        predecessor: null,
        duration: 7200,
        scheduledStartDate: fixedNow,
        scheduledEndDate: new Date(fixedNow.getTime() + 7200 * 1000),
        actualStartDate: fixedNow,
        actualEndDate: null,
        constraints: [],
        createdAt: fixedNow,
        createdBy: 'tester',
        updatedAt: fixedNow,
        updatedBy: 'tester',
      };

      const challengeRecord = {
        id: 'challenge-regular-review',
        name: 'Regular Review Challenge',
        status: ChallengeStatusEnum.ACTIVE,
        phases: [reviewPhase],
        currentPhaseNames: ['Review'],
        reviewers: [],
        winners: [],
        track: { name: 'DEVELOP' },
        type: { name: 'Standard' },
      };

      challengeFindUnique
        .mockResolvedValueOnce(challengeRecord as any)
        .mockResolvedValueOnce(challengeRecord as any);

      const queryRawSpy = jest.fn();
      prisma.$queryRaw = queryRawSpy;

      await service.advancePhase(
        'challenge-regular-review',
        'regular-review-phase',
        'close',
      );

      // Should not call $queryRaw for pending AI decisions on non-AI Review phases
      expect(queryRawSpy).not.toHaveBeenCalled();
    });
  });

  describe('createPostMortemPhasePreserving', () => {
    const buildPhase = (overrides: Partial<any> = {}) => {
      const scheduledStart = new Date('2025-09-25T00:00:00.000Z');
      return {
        id: 'phase-default',
        phaseId: 'template-default',
        name: 'Generic Phase',
        description: null,
        isOpen: false,
        predecessor: null,
        duration: 3600,
        scheduledStartDate: scheduledStart,
        scheduledEndDate: new Date(scheduledStart.getTime() + 3600 * 1000),
        actualStartDate: null,
        actualEndDate: null,
        constraints: [],
        ...overrides,
      };
    };

    it('closes open Approval phases when opening Post-Mortem immediately', async () => {
      const challengeId = 'challenge-close-approval';
      const predecessorPhase = buildPhase({
        id: 'phase-review',
        phaseId: 'template-review',
        name: 'Review',
        actualEndDate: new Date('2025-09-25T03:00:00.000Z'),
      });
      const approvalPhase = buildPhase({
        id: 'phase-approval',
        phaseId: 'template-approval',
        name: 'Approval',
        isOpen: true,
      });

      txChallengeFindUnique.mockResolvedValueOnce({
        id: challengeId,
        phases: [predecessorPhase, approvalPhase],
        currentPhaseNames: ['Approval'],
      } as any);

      const postMortemPhaseType = {
        id: 'template-postmortem',
        name: 'Post-Mortem',
        description: 'Post-Mortem phase',
      };
      txPhaseFindFirst.mockResolvedValueOnce(postMortemPhaseType as any);

      const createdPostMortem = {
        id: 'phase-postmortem',
      };
      challengePhaseCreate.mockResolvedValueOnce(createdPostMortem as any);

      const scheduledEnd = new Date(fixedNow.getTime() + 72 * 60 * 60 * 1000);
      challengeFindUnique.mockResolvedValueOnce({
        id: challengeId,
        phases: [
          predecessorPhase,
          {
            ...createdPostMortem,
            phaseId: postMortemPhaseType.id,
            name: postMortemPhaseType.name,
            description: postMortemPhaseType.description,
            isOpen: true,
            duration: 72 * 60 * 60,
            scheduledStartDate: fixedNow,
            scheduledEndDate: scheduledEnd,
            actualStartDate: fixedNow,
            actualEndDate: null,
            predecessor: predecessorPhase.phaseId ?? predecessorPhase.id,
            constraints: [],
          },
        ],
      } as any);

      const result = await service.createPostMortemPhasePreserving(
        challengeId,
        predecessorPhase.id,
        72,
        true,
      );

      expect(challengePhaseUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: [approvalPhase.id] } },
        data: expect.objectContaining({
          isOpen: false,
          actualStartDate: fixedNow,
          actualEndDate: fixedNow,
          updatedBy: 'Autopilot',
        }),
      });
      expect(challengeUpdate).toHaveBeenCalledWith({
        where: { id: challengeId },
        data: { currentPhaseNames: ['Post-Mortem'] },
      });
      expect(result.id).toBe(createdPostMortem.id);
      expect(dbLogger.logAction).toHaveBeenLastCalledWith(
        'challenge.createPostMortemPhase',
        expect.objectContaining({
          details: expect.objectContaining({
            closedApprovalPhaseCount: 1,
            postMortemPhaseId: createdPostMortem.id,
          }),
        }),
      );
    });

    it('does not close approval phases when not opening immediately', async () => {
      const challengeId = 'challenge-preserve';
      const predecessorPhase = buildPhase({
        id: 'phase-submission',
        phaseId: 'template-submission',
        name: 'Submission',
      });
      const approvalPhase = buildPhase({
        id: 'phase-approval',
        phaseId: 'template-approval',
        name: 'Approval',
        isOpen: true,
      });

      txChallengeFindUnique.mockResolvedValueOnce({
        id: challengeId,
        phases: [predecessorPhase, approvalPhase],
        currentPhaseNames: ['Approval'],
      } as any);

      const postMortemPhaseType = {
        id: 'template-postmortem',
        name: 'Post-Mortem',
        description: 'Post-Mortem phase',
      };
      txPhaseFindFirst.mockResolvedValueOnce(postMortemPhaseType as any);

      const createdPostMortem = { id: 'phase-postmortem' };
      challengePhaseCreate.mockResolvedValueOnce(createdPostMortem as any);

      const scheduledEnd = new Date(fixedNow.getTime() + 48 * 60 * 60 * 1000);
      challengeFindUnique.mockResolvedValueOnce({
        id: challengeId,
        phases: [
          predecessorPhase,
          approvalPhase,
          {
            ...createdPostMortem,
            phaseId: postMortemPhaseType.id,
            name: postMortemPhaseType.name,
            description: postMortemPhaseType.description,
            isOpen: false,
            duration: 48 * 60 * 60,
            scheduledStartDate: fixedNow,
            scheduledEndDate: scheduledEnd,
            actualStartDate: null,
            actualEndDate: null,
            predecessor: predecessorPhase.phaseId ?? predecessorPhase.id,
            constraints: [],
          },
        ],
      } as any);

      challengePhaseUpdateMany.mockClear();
      challengeUpdate.mockClear();

      const result = await service.createPostMortemPhasePreserving(
        challengeId,
        predecessorPhase.id,
        48,
        false,
      );

      expect(challengePhaseUpdateMany).not.toHaveBeenCalled();
      expect(challengeUpdate).not.toHaveBeenCalled();
      expect(result.id).toBe(createdPostMortem.id);
    });
  });
});

describe('ChallengeApiService - end date handling', () => {
  const fixedNow = new Date('2025-01-15T12:30:00.000Z');

  let prisma: jest.Mocked<ChallengePrismaService>;
  let dbLogger: jest.Mocked<AutopilotDbLoggerService>;
  let service: ChallengeApiService;
  let challengeUpdate: jest.Mock;
  let challengeWinnerDeleteMany: jest.Mock;
  let challengeWinnerCreateMany: jest.Mock;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(fixedNow);

    challengeUpdate = jest.fn().mockResolvedValue(undefined);
    challengeWinnerDeleteMany = jest.fn().mockResolvedValue(undefined);
    challengeWinnerCreateMany = jest.fn().mockResolvedValue(undefined);

    prisma = {
      challenge: {
        update: challengeUpdate,
      },
      challengeWinner: {
        deleteMany: challengeWinnerDeleteMany,
        createMany: challengeWinnerCreateMany,
      },
      $transaction: jest.fn(),
    } as unknown as jest.Mocked<ChallengePrismaService>;

    prisma.$transaction.mockImplementation(async (callback) => {
      await callback({
        challenge: { update: challengeUpdate },
        challengeWinner: {
          deleteMany: challengeWinnerDeleteMany,
          createMany: challengeWinnerCreateMany,
        },
      } as unknown as ChallengePrismaService);
    });

    dbLogger = {
      logAction: jest.fn(),
    } as unknown as jest.Mocked<AutopilotDbLoggerService>;

    configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<ConfigService>;

    service = new ChallengeApiService(prisma, dbLogger, configService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sets the endDate when completing a challenge', async () => {
    const winners = [
      { userId: 123, handle: 'winner', placement: 1 },
      {
        userId: 456,
        handle: 'runner-up',
        placement: 1,
        type: PrizeSetTypeEnum.PASSED_REVIEW,
      },
    ];

    await service.completeChallenge('challenge-123', winners);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(challengeUpdate).toHaveBeenCalledWith({
      where: { id: 'challenge-123' },
      data: {
        status: ChallengeStatusEnum.COMPLETED,
        endDate: fixedNow,
      },
    });
    expect(challengeWinnerDeleteMany).toHaveBeenCalledWith({
      where: {
        challengeId: 'challenge-123',
        type: { in: ['PLACEMENT', 'PASSED_REVIEW'] },
      },
    });
    expect(challengeWinnerCreateMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ challengeId: 'challenge-123' }),
        expect.objectContaining({
          challengeId: 'challenge-123',
          type: PrizeSetTypeEnum.PASSED_REVIEW,
        }),
      ]),
    });
    expect(dbLogger.logAction).toHaveBeenCalledWith(
      'challenge.completeChallenge',
      expect.objectContaining({
        details: expect.objectContaining({
          winnersCount: winners.length,
          endDate: fixedNow.toISOString(),
        }),
      }),
    );
  });

  it('sets the endDate when cancelling a challenge', async () => {
    await service.cancelChallenge(
      'challenge-456',
      ChallengeStatusEnum.CANCELLED_FAILED_REVIEW,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(challengeUpdate).toHaveBeenCalledWith({
      where: { id: 'challenge-456' },
      data: {
        status: ChallengeStatusEnum.CANCELLED_FAILED_REVIEW,
        endDate: fixedNow,
      },
    });
    expect(challengeWinnerDeleteMany).toHaveBeenCalledWith({
      where: { challengeId: 'challenge-456' },
    });
    expect(challengeWinnerCreateMany).not.toHaveBeenCalled();
    expect(dbLogger.logAction).toHaveBeenCalledWith(
      'challenge.cancelChallenge',
      expect.objectContaining({
        details: {
          status: ChallengeStatusEnum.CANCELLED_FAILED_REVIEW,
          endDate: fixedNow.toISOString(),
        },
      }),
    );
  });
});
