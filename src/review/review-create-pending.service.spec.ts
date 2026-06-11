import type {
  AutopilotDbLoggerService,
  AutopilotDbLogPayload,
} from '../autopilot/services/autopilot-db-logger.service';
import type { ReviewPrismaService } from './review-prisma.service';
import { ReviewService } from './review.service';

type RawSqlQuery = {
  strings?: TemplateStringsArray | string[];
};

type QueryRawMock = jest.Mock<
  Promise<Array<Record<string, unknown>>>,
  [unknown]
>;
type ExecuteRawMock = jest.Mock<Promise<number>, [unknown]>;

type TransactionDelegate = {
  $executeRaw: ExecuteRawMock;
  $queryRaw: QueryRawMock;
};

type TransactionMock = jest.Mock<
  Promise<unknown>,
  [callback: (tx: TransactionDelegate) => Promise<unknown>]
>;

type CreatePendingReviewLogPayload = AutopilotDbLogPayload & {
  status: string;
  details: {
    created: boolean;
    reviewId: string | null;
    pendingReviewIds: string[];
  };
};

describe('ReviewService createPendingReview', () => {
  const challengeId = 'challenge-1';
  const phaseId = 'phase-review';
  const submissionId = 'submission-1';
  const resourceId = 'resource-1';

  let executeRawMock: ExecuteRawMock;
  let logActionMock: jest.MockedFunction<AutopilotDbLoggerService['logAction']>;
  let queryRawMock: QueryRawMock;
  let service: ReviewService;
  let transactionMock: TransactionMock;

  beforeEach(() => {
    executeRawMock = jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0);
    queryRawMock = jest
      .fn<Promise<Array<Record<string, unknown>>>, [unknown]>()
      .mockResolvedValue([]);
    transactionMock = jest
      .fn<
        Promise<unknown>,
        [callback: (tx: TransactionDelegate) => Promise<unknown>]
      >()
      .mockImplementation(async (callback) =>
        callback({
          $executeRaw: executeRawMock,
          $queryRaw: queryRawMock,
        }),
      );
    logActionMock = jest.fn().mockResolvedValue(undefined);

    service = new ReviewService(
      {
        $executeRaw: executeRawMock,
        $queryRaw: queryRawMock,
        $transaction: transactionMock,
      } as unknown as ReviewPrismaService,
      { logAction: logActionMock } as unknown as AutopilotDbLoggerService,
    );
  });

  it('reuses an existing pending assignment even when its scorecard drifted', async () => {
    queryRawMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'review-existing',
        scorecardId: 'old-scorecard',
        status: 'PENDING',
      },
    ]);

    const result = await service.createPendingReview(
      submissionId,
      resourceId,
      phaseId,
      'new-scorecard',
      challengeId,
    );

    expect(result).toEqual({
      created: false,
      reviewId: 'review-existing',
    });
    expect(queryRawMock).toHaveBeenCalledTimes(2);
    expect(executeRawMock).toHaveBeenCalledTimes(2);

    const executeRawCalls = executeRawMock.mock.calls as unknown as Array<
      [RawSqlQuery]
    >;
    const updateQuery = executeRawCalls[1]?.[0];
    const sqlText = Array.isArray(updateQuery?.strings)
      ? updateQuery.strings.join('')
      : '';

    expect(sqlText).toContain('UPDATE');
    expect(sqlText).toContain('"scorecardId"');
    expect(sqlText).toContain('"typeId"');

    const createPendingReviewLog = logActionMock.mock.calls.find(
      ([action]) => action === 'review.createPendingReview',
    )?.[1] as CreatePendingReviewLogPayload | undefined;

    expect(createPendingReviewLog).toMatchObject({
      status: 'SUCCESS',
      details: {
        created: false,
        reviewId: 'review-existing',
        pendingReviewIds: ['review-existing'],
      },
    });
  });

  it('populates the review type when creating a pending assignment', async () => {
    queryRawMock.mockResolvedValueOnce([{ id: 'review-created' }]);

    const result = await service.createPendingReview(
      submissionId,
      resourceId,
      phaseId,
      'scorecard-review',
      challengeId,
    );

    expect(result).toEqual({
      created: true,
      reviewId: 'review-created',
    });
    expect(queryRawMock).toHaveBeenCalledTimes(1);

    const queryRawCalls = queryRawMock.mock.calls as unknown as Array<
      [RawSqlQuery]
    >;
    const insertQuery = queryRawCalls[0]?.[0];
    const sqlText = Array.isArray(insertQuery?.strings)
      ? insertQuery.strings.join('')
      : '';

    expect(sqlText).toContain('"typeId"');
    expect(sqlText).toContain('review_type."isActive" = true');
    expect(sqlText).toContain("WHEN 'REVIEW' THEN 'review'");
  });

  it('does not create another pending assignment when the same review is already completed', async () => {
    queryRawMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'review-completed',
        scorecardId: 'scorecard-review',
        status: 'COMPLETED',
      },
    ]);

    const result = await service.createPendingReview(
      submissionId,
      resourceId,
      phaseId,
      'scorecard-review',
      challengeId,
    );

    expect(result).toEqual({
      created: false,
      reviewId: null,
    });
    expect(queryRawMock).toHaveBeenCalledTimes(2);
    expect(executeRawMock).toHaveBeenCalledTimes(1);

    const createPendingReviewLog = logActionMock.mock.calls.find(
      ([action]) => action === 'review.createPendingReview',
    )?.[1] as CreatePendingReviewLogPayload | undefined;

    expect(createPendingReviewLog).toMatchObject({
      status: 'SUCCESS',
      details: {
        created: false,
        reviewId: null,
        pendingReviewIds: [],
      },
    });
  });
});
