import { ReviewService } from './review.service';

describe('ReviewService.getTopFinalReviewScores', () => {
  const challengeId = 'challenge-1';

  let prismaMock: { $queryRaw: jest.Mock };
  let dbLoggerMock: { logAction: jest.Mock };
  let service: ReviewService;

  beforeEach(() => {
    prismaMock = {
      $queryRaw: jest.fn(),
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
