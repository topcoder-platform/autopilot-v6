import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import {
  AxiosHeaders,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { of } from 'rxjs';
import { Auth0Service } from '../../auth/auth0.service';
import type { IChallenge } from '../../challenge/interfaces/challenge.interface';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { MembersService } from '../../members/members.service';
import { ResourcesService } from '../../resources/resources.service';
import type { AutopilotDbLoggerService } from './autopilot-db-logger.service';
import { PhaseChangeNotificationService } from './phase-change-notification.service';

interface PublishedEmailPayload {
  from: string;
  replyTo: string;
  recipients: string[];
  bcc: string[];
  sendgrid_template_id: string | null;
  version: string;
  data: {
    challengeName: string;
    challengeURL: string;
    phaseOpen: string | null;
    phaseOpenDate: string | null;
    phaseClose: string | null;
    phaseCloseDate: string | null;
  };
}

interface PublishedEmailMessage {
  topic: string;
  originator: string;
  timestamp: string;
  'mime-type': string;
  payload: PublishedEmailPayload;
}

/**
 * Builds a challenge payload with a single phase for notification tests.
 *
 * @param phase overrides for the phase included on the challenge.
 * @returns challenge data shaped like the Challenge API response used by the service.
 */
const buildChallenge = (
  phase: Partial<IChallenge['phases'][number]> = {},
): IChallenge => ({
  id: 'challenge-1',
  name: 'Phase Change Challenge',
  description: null,
  descriptionFormat: 'markdown',
  projectId: 1,
  typeId: 'type-1',
  trackId: 'track-1',
  timelineTemplateId: 'timeline-template-1',
  currentPhaseNames: [],
  tags: [],
  groups: [],
  submissionStartDate: new Date().toISOString(),
  submissionEndDate: new Date().toISOString(),
  registrationStartDate: new Date().toISOString(),
  registrationEndDate: new Date().toISOString(),
  startDate: new Date().toISOString(),
  endDate: null,
  legacyId: null,
  status: 'ACTIVE',
  createdBy: 'tester',
  updatedBy: 'tester',
  metadata: {},
  phases: [
    {
      id: 'phase-1',
      phaseId: 'phase-1',
      name: 'Review',
      description: null,
      isOpen: true,
      duration: 3600,
      scheduledStartDate: '2026-03-11T10:00:00.000Z',
      scheduledEndDate: '2026-03-11T11:00:00.000Z',
      actualStartDate: '2026-03-11T10:00:00.000Z',
      actualEndDate: null,
      predecessor: null,
      constraints: [],
      ...phase,
    },
  ],
  reviewers: [],
  winners: [],
  discussions: [],
  events: [],
  prizeSets: [],
  terms: [],
  skills: [],
  attachments: [],
  track: 'Development',
  type: 'Challenge',
  legacy: {},
  task: {},
  created: new Date().toISOString(),
  updated: new Date().toISOString(),
  overview: {},
  numOfSubmissions: 0,
  numOfCheckpointSubmissions: 0,
  numOfRegistrants: 0,
});

describe('PhaseChangeNotificationService', () => {
  let service: PhaseChangeNotificationService;
  let resourcesService: jest.Mocked<ResourcesService>;
  let membersService: jest.Mocked<MembersService>;
  let challengeApiService: jest.Mocked<ChallengeApiService>;
  let auth0Service: jest.Mocked<Auth0Service>;
  let httpService: jest.Mocked<HttpService>;
  let configService: jest.Mocked<ConfigService>;
  let dbLogger: jest.Mocked<AutopilotDbLoggerService>;

  beforeEach(() => {
    resourcesService = {
      getPhaseChangeNotificationResources: jest.fn(),
    } as unknown as jest.Mocked<ResourcesService>;

    membersService = {
      getMemberEmails: jest.fn(),
    } as unknown as jest.Mocked<MembersService>;

    challengeApiService = {
      getChallengeById: jest.fn(),
    } as unknown as jest.Mocked<ChallengeApiService>;

    auth0Service = {
      getAccessToken: jest.fn(),
    } as unknown as jest.Mocked<Auth0Service>;

    httpService = {
      post: jest.fn(),
    } as unknown as jest.Mocked<HttpService>;

    configService = {
      get: jest.fn((key: string) => {
        switch (key) {
          case 'bus.url':
            return 'https://bus-api.topcoder.com';
          case 'bus.timeoutMs':
            return 5000;
          case 'bus.originator':
            return 'autopilot-service';
          case 'app.reviewAppUrl':
            return 'https://review.topcoder.com';
          case 'autopilot.phaseNotificationSendgridTemplateId':
            return 'sendgrid-template-id';
          default:
            return undefined;
        }
      }),
    } as unknown as jest.Mocked<ConfigService>;

    dbLogger = {
      logAction: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AutopilotDbLoggerService>;

    service = new PhaseChangeNotificationService(
      resourcesService,
      membersService,
      challengeApiService,
      auth0Service,
      httpService,
      configService,
      dbLogger,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('publishes phase change emails with opted-in members in bcc', async () => {
    resourcesService.getPhaseChangeNotificationResources.mockResolvedValue([
      {
        id: 'resource-1',
        memberId: '1001',
        memberHandle: 'first-member',
        roleName: 'Reviewer',
      },
      {
        id: 'resource-2',
        memberId: '1002',
        memberHandle: 'second-member',
        roleName: 'Copilot',
      },
    ]);
    membersService.getMemberEmails.mockResolvedValue({
      idToEmail: new Map([
        ['1001', 'first@example.com'],
        ['1002', 'second@example.com'],
      ]),
      handleToEmail: new Map(),
    });
    challengeApiService.getChallengeById.mockResolvedValue(buildChallenge());
    auth0Service.getAccessToken.mockResolvedValue('token');
    const response: AxiosResponse<Record<string, never>> = {
      data: {},
      status: 202,
      statusText: 'Accepted',
      headers: {},
      config: {
        headers: new AxiosHeaders(),
      } as InternalAxiosRequestConfig,
    };
    httpService.post.mockReturnValue(of(response));

    await service.sendPhaseChangeNotification({
      challengeId: 'challenge-1',
      phaseId: 'phase-1',
      operation: 'open',
    });

    expect(httpService.post.mock.calls).toHaveLength(1);

    const [url, message, options] = httpService.post.mock.calls[0] as [
      string,
      PublishedEmailMessage,
      {
        headers: {
          Authorization: string;
          'Content-Type': string;
        };
        timeout: number;
      },
    ];

    expect(url).toBe('https://bus-api.topcoder.com/v5/bus/events');
    expect(message.topic).toBe('external.action.email');
    expect(message.payload.from).toBe('no-reply@topcoder.com');
    expect(message.payload.replyTo).toBe('no-reply@topcoder.com');
    expect(message.payload.recipients).toEqual(['no-reply@topcoder.com']);
    expect(message.payload.bcc).toEqual([
      'first@example.com',
      'second@example.com',
    ]);
    expect(message.payload.sendgrid_template_id).toBe('sendgrid-template-id');
    expect(message.payload.version).toBe('v3');
    expect(message.payload.data.challengeName).toBe('Phase Change Challenge');
    expect(message.payload.data.challengeURL).toBe(
      'https://review.topcoder.com/active-challenges/challenge-1/challenge-details',
    );
    expect(message.payload.data.phaseOpen).toBe('Review');
    expect(message.payload.data.phaseClose).toBeNull();
    expect(options.headers.Authorization).toBe('Bearer token');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(options.timeout).toBe(5000);
  });
});
