import { ReviewService } from './review.service';

describe('ReviewService', () => {
  const challengeId = 'challenge-1';

  let prismaMock: {
    $queryRaw: jest.Mock;
    $executeRaw: jest.Mock;
    $transaction: jest.Mock;
  };
  let dbLoggerMock: { logAction: jest.Mock };
  let service: ReviewService;

  beforeEach(() => {
    const executeRawMock = jest.fn().mockResolvedValue(undefined);
    prismaMock = {
      $queryRaw: jest.fn(),
      $executeRaw: executeRawMock,
      $transaction: jest
        .fn()
        .mockImplementation(
          async (callback: (tx: { $executeRaw: typeof executeRawMock }) => Promise<void>) => {
            await callback({ $executeRaw: executeRawMock });
          },
        ),
    };
    dbLoggerMock = {
      logAction: jest.fn(),
    };

    service = new ReviewService(
      prismaMock as unknown as any,
      dbLoggerMock as unknown as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getTopFinalReviewScores', () => {
    it('returns winners from review summations when available', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([
        {
          memberId: ' 123 ',
          submissionId: 'submission-1',
          aggregateScore: '98.5',
        },
        {
          memberId: '123',
          submissionId: 'submission-2',
          aggregateScore: 90,
        },
      ]);

      const winners = await service.getTopFinalReviewScores(challengeId, 2);

      expect(winners).toEqual([
        {
          memberId: '123',
          submissionId: 'submission-1',
          aggregateScore: 98.5,
        },
      ]);
      expect(dbLoggerMock.logAction).toHaveBeenCalledWith(
        'review.getTopFinalReviewScores',
        expect.objectContaining({
          details: expect.objectContaining({
            dataSource: 'reviewSummation',
            winnersCount: 1,
          }),
        }),
      );
    });

    it('falls back to generated summaries when summations are empty', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([]);

      const summariesSpy = jest
        .spyOn(service, 'generateReviewSummaries')
        .mockResolvedValue([
          {
            submissionId: 'submission-3',
            legacySubmissionId: null,
            memberId: '456',
            submittedDate: new Date('2024-01-01T00:00:00Z'),
            aggregateScore: 92,
            scorecardId: null,
            scorecardLegacyId: null,
            passingScore: 80,
            isPassing: true,
          },
          {
            submissionId: 'submission-4',
            legacySubmissionId: null,
            memberId: null,
            submittedDate: new Date('2024-01-02T00:00:00Z'),
            aggregateScore: 99,
            scorecardId: null,
            scorecardLegacyId: null,
            passingScore: 80,
            isPassing: true,
          },
        ]);

      const winners = await service.getTopFinalReviewScores(challengeId, 1);

      expect(summariesSpy).toHaveBeenCalledWith(challengeId);
      expect(winners).toEqual([
        {
          memberId: '456',
          submissionId: 'submission-3',
          aggregateScore: 92,
        },
      ]);
      expect(dbLoggerMock.logAction).toHaveBeenCalledWith(
        'review.getTopFinalReviewScores',
        expect.objectContaining({
          details: expect.objectContaining({
            dataSource: 'reviewSummaries',
            winnersCount: 1,
          }),
        }),
      );
    });
  });

  describe('getTopCheckpointReviewScores', () => {
    const phaseId = 'phase-checkpoint-review';

    it('filters to checkpoint reviews that meet minimum passing score', async () => {
      prismaMock.$queryRaw.mockResolvedValue([
        { memberId: '123', submissionId: 'submission-1', score: 92 },
      ]);

      const winners = await service.getTopCheckpointReviewScores(
        challengeId,
        phaseId,
        3,
      );

      expect(winners).toEqual([
        { memberId: '123', submissionId: 'submission-1', score: 92 },
      ]);

      const rawQuery = prismaMock.$queryRaw.mock.calls[0][0] as {
        strings?: TemplateStringsArray | string[];
      };
      const sqlText = Array.isArray(rawQuery?.strings)
        ? rawQuery.strings.join('')
        : '';

      expect(sqlText).toContain('GREATEST(');
      expect(sqlText).toContain('minimumPassingScore');
      expect(sqlText).toContain('minScore');
      expect(sqlText).toContain('"scorecard"');
    });
  });

  describe('getCheckpointPassedSubmissionIds', () => {
    const screeningScorecardId = 'scorecard-1';

    it('includes fallback logic for raw scores and minimum score thresholds', async () => {
      prismaMock.$queryRaw.mockResolvedValue([{ id: 'submission-1' }]);

      const result = await service.getCheckpointPassedSubmissionIds(
        challengeId,
        screeningScorecardId,
      );

      expect(result).toEqual(['submission-1']);
      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);

      const rawQuery = prismaMock.$queryRaw.mock.calls[0][0] as {
        strings?: TemplateStringsArray | string[];
      };
      const sqlText = Array.isArray(rawQuery?.strings)
        ? rawQuery.strings.join('')
        : '';

      expect(sqlText).toContain('GREATEST(');
      expect(sqlText).toContain('r."initialScore"');
      expect(sqlText).toContain('sc."minScore"');

      expect(dbLoggerMock.logAction).toHaveBeenCalledWith(
        'review.getCheckpointPassedSubmissionIds',
        expect.objectContaining({
          details: expect.objectContaining({
            screeningScorecardId,
            submissionCount: 1,
          }),
        }),
      );
    });
  });

  describe('getFailedScreeningSubmissionIds', () => {
    it('returns an empty set when scorecard list is empty', async () => {
      const result = await service.getFailedScreeningSubmissionIds(
        challengeId,
        [],
      );

      expect(result.size).toBe(0);
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
      expect(dbLoggerMock.logAction).not.toHaveBeenCalled();
    });

    it('filters completed reviews using both final and raw scores', async () => {
      prismaMock.$queryRaw.mockResolvedValue([{ id: 'submission-2' }]);

      const result = await service.getFailedScreeningSubmissionIds(
        challengeId,
        ['scorecard-1'],
      );

      expect(result).toEqual(new Set(['submission-2']));
      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
      const rawQuery = prismaMock.$queryRaw.mock.calls[0][0] as {
        strings?: TemplateStringsArray | string[];
      };
      const sqlText = Array.isArray(rawQuery?.strings)
        ? rawQuery.strings.join('')
        : '';

      expect(sqlText).toContain('GREATEST(');
      expect(sqlText).toContain('r."initialScore"');
      expect(sqlText).toContain('sc."minScore"');

      expect(dbLoggerMock.logAction).toHaveBeenCalledWith(
        'review.getFailedScreeningSubmissionIds',
        expect.objectContaining({
          details: expect.objectContaining({
            screeningScorecardCount: 1,
            failedSubmissionCount: 1,
          }),
        }),
      );
    });

    it('returns failed submission ids when query succeeds', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([
        { id: 'failed-1' },
        { id: 'failed-2' },
        { id: 'failed-1' },
      ]);

      const result = await service.getFailedScreeningSubmissionIds(
        challengeId,
        ['screening-1'],
      );

      expect(result).toEqual(new Set(['failed-1', 'failed-2']));
      expect(dbLoggerMock.logAction).toHaveBeenCalledWith(
        'review.getFailedScreeningSubmissionIds',
        expect.objectContaining({
          status: 'SUCCESS',
          details: expect.objectContaining({
            failedSubmissionCount: 2,
          }),
        }),
      );
    });
  });

  describe('updatePendingReviewScorecards', () => {
    const phaseId = 'phase-1';
    const scorecardId = 'scorecard-123';

    it('returns 0 when phaseId or scorecardId is missing', async () => {
      const result = await service.updatePendingReviewScorecards(
        challengeId,
        '   ',
        scorecardId,
      );

      expect(result).toBe(0);
      expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
      expect(dbLoggerMock.logAction).not.toHaveBeenCalled();
    });

    it('updates pending reviews and logs success', async () => {
      prismaMock.$executeRaw.mockResolvedValueOnce(3);

      const result = await service.updatePendingReviewScorecards(
        challengeId,
        phaseId,
        scorecardId,
      );

      expect(result).toBe(3);
      expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
      expect(dbLoggerMock.logAction).toHaveBeenCalledWith(
        'review.updatePendingReviewScorecards',
        expect.objectContaining({
          status: 'SUCCESS',
          details: expect.objectContaining({
            phaseId,
            scorecardId,
            updatedCount: 3,
          }),
        }),
      );
    });

    it('logs error and rethrows when update fails', async () => {
      prismaMock.$executeRaw.mockRejectedValueOnce(
        new Error('database unavailable'),
      );

      await expect(
        service.updatePendingReviewScorecards(
          challengeId,
          phaseId,
          scorecardId,
        ),
      ).rejects.toThrow('database unavailable');

      expect(dbLoggerMock.logAction).toHaveBeenCalledWith(
        'review.updatePendingReviewScorecards',
        expect.objectContaining({
          status: 'ERROR',
          details: expect.objectContaining({
            phaseId,
            scorecardId,
            error: 'database unavailable',
          }),
        }),
      );
    });
  });

  describe('reassignPendingReviewsToResource', () => {
    const phaseId = 'phase-approval';
    const resourceId = 'resource-987';

    it('returns 0 when phaseId or resourceId is missing', async () => {
      const result = await service.reassignPendingReviewsToResource(
        '   ',
        resourceId,
        challengeId,
      );

      expect(result).toBe(0);
      expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
      expect(dbLoggerMock.logAction).not.toHaveBeenCalled();
    });

    it('updates pending reviews and logs success', async () => {
      prismaMock.$executeRaw.mockResolvedValueOnce(2);

      const result = await service.reassignPendingReviewsToResource(
        phaseId,
        resourceId,
        challengeId,
      );

      expect(result).toBe(2);
      expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
      expect(dbLoggerMock.logAction).toHaveBeenCalledWith(
        'review.reassignPendingReviewsToResource',
        expect.objectContaining({
          status: 'SUCCESS',
          details: expect.objectContaining({
            phaseId,
            resourceId,
            reassignedCount: 2,
          }),
        }),
      );
    });

    it('logs error and rethrows when update fails', async () => {
      const error = new Error('update failed');
      prismaMock.$executeRaw.mockRejectedValueOnce(error);

      await expect(
        service.reassignPendingReviewsToResource(
          phaseId,
          resourceId,
          challengeId,
        ),
      ).rejects.toThrow('update failed');

      expect(dbLoggerMock.logAction).toHaveBeenCalledWith(
        'review.reassignPendingReviewsToResource',
        expect.objectContaining({
          status: 'ERROR',
          details: expect.objectContaining({
            phaseId,
            resourceId,
            error: 'update failed',
          }),
        }),
      );
    });
  });

  describe('generateReviewSummaries', () => {
    const buildReviewSummationRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
      submissionId: 'submission-1',
      legacySubmissionId: 'legacy-1',
      memberId: '123456',
      submittedDate: '2024-10-21T10:00:00.000Z',
      aggregateScore: '70',
      scorecardId: 'scorecard-1',
      scorecardLegacyId: 'legacy-scorecard',
      isPassing: false,
      minimumPassingScore: '80',
      ...overrides,
    });

    const buildAggregationRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
      submissionId: 'submission-1',
      legacySubmissionId: 'legacy-1',
      memberId: '123456',
      submittedDate: '2024-10-21T10:00:00.000Z',
      aggregateScore: '95',
      scorecardId: 'scorecard-1',
      scorecardLegacyId: 'legacy-scorecard',
      minimumPassingScore: '80',
      ...overrides,
    });

    it('rebuilds summaries when stored summations have no passing submissions but recomputed data does', async () => {
      prismaMock.$queryRaw
        .mockResolvedValueOnce([buildReviewSummationRow()])
        .mockResolvedValueOnce([buildAggregationRow()]);

      const summaries = await service.generateReviewSummaries(challengeId);

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);

      expect(summaries).toEqual([
        {
          submissionId: 'submission-1',
          legacySubmissionId: 'legacy-1',
          memberId: '123456',
          submittedDate: new Date('2024-10-21T10:00:00.000Z'),
          aggregateScore: 95,
          scorecardId: 'scorecard-1',
          scorecardLegacyId: 'legacy-scorecard',
          passingScore: 80,
          isPassing: true,
        },
      ]);

      expect(dbLoggerMock.logAction).toHaveBeenCalledWith(
        'review.generateReviewSummaries',
        expect.objectContaining({
          details: expect.objectContaining({
            submissionCount: 1,
            passingCount: 1,
            rebuiltFromReviews: true,
          }),
        }),
      );
    });
  });
});
