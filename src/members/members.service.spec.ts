import type { AutopilotDbLoggerService } from '../autopilot/services/autopilot-db-logger.service';
import type { MembersPrismaService } from './members-prisma.service';
import { MembersService } from './members.service';

type RawSqlQuery = {
  strings?: TemplateStringsArray | string[];
};

type QueryRawMock = jest.Mock<
  Promise<Array<Record<string, unknown>>>,
  [unknown]
>;

describe('MembersService', () => {
  let queryRawMock: QueryRawMock;
  let service: MembersService;

  beforeEach(() => {
    queryRawMock = jest.fn();
    service = new MembersService(
      {
        $queryRaw: queryRawMock,
      } as unknown as MembersPrismaService,
      {
        logAction: jest.fn().mockResolvedValue(undefined),
      } as unknown as AutopilotDbLoggerService,
    );
  });

  it('maps member emails and first-address locations by ID and handle', async () => {
    queryRawMock
      .mockResolvedValueOnce([
        {
          userId: 1001n,
          email: ' first@example.com ',
          city: ' Hobart ',
          homeCountryCode: ' AUS ',
          competitionCountryCode: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          handleLower: 'second-member',
          email: ' second@example.com ',
          city: null,
          homeCountryCode: null,
          competitionCountryCode: ' USA ',
        },
      ]);

    const result = await service.getMemberEmails({
      memberIds: [' 1001 ', 'not-numeric', '1001'],
      handles: [' Second-Member ', 'second-member'],
    });

    expect(result.idToMember.get('1001')).toEqual({
      email: 'first@example.com',
      city: 'Hobart',
      homeCountryCode: 'AUS',
      competitionCountryCode: null,
    });
    expect(result.handleToMember.get('second-member')).toEqual({
      email: 'second@example.com',
      city: null,
      homeCountryCode: null,
      competitionCountryCode: 'USA',
    });
    expect(queryRawMock).toHaveBeenCalledTimes(2);

    for (const [query] of queryRawMock.mock.calls) {
      const sql = (query as RawSqlQuery).strings?.join('') ?? '';
      expect(sql).toContain('FROM "memberAddress" a');
      expect(sql).toContain('LIMIT 1');
    }
  });
});
