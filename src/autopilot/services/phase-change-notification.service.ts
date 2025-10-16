import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { ResourcesService } from '../../resources/resources.service';
import { MembersService } from '../../members/members.service';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { Auth0Service } from '../../auth/auth0.service';
import { AutopilotDbLoggerService } from './autopilot-db-logger.service';

export interface PhaseChangeNotificationParams {
  challengeId: string;
  phaseId: string;
  operation: 'open' | 'close';
}

interface NotificationPayloadData {
  challengeName: string;
  challengeURL: string;
  phaseOpen: string | null;
  phaseOpenDate: string | null;
  phaseClose: string | null;
  phaseCloseDate: string | null;
}

@Injectable()
export class PhaseChangeNotificationService {
  private readonly logger = new Logger(PhaseChangeNotificationService.name);
  private readonly busEventsUrl: string | null;
  private readonly timeoutMs: number;
  private readonly originator: string;
  private readonly reviewAppBaseUrl: string;
  private readonly emailDomain: string;
  private readonly sendgridTemplateId: string | null;
  private readonly easternTimeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  constructor(
    private readonly resourcesService: ResourcesService,
    private readonly membersService: MembersService,
    private readonly challengeApiService: ChallengeApiService,
    private readonly auth0Service: Auth0Service,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly dbLogger: AutopilotDbLoggerService,
  ) {
    const baseUrl = this.configService.get<string>('bus.url')?.trim();
    this.busEventsUrl = baseUrl ? this.buildEventsUrl(baseUrl) : null;
    this.timeoutMs = this.configService.get<number>('bus.timeoutMs') ?? 10000;
    this.originator =
      this.configService.get<string>('bus.originator') ?? 'autopilot-service';
    this.reviewAppBaseUrl = this.resolveReviewAppBaseUrl();
    this.emailDomain = this.resolveEmailDomain(this.reviewAppBaseUrl);
    const templateId = this.configService
      .get<string>('autopilot.phaseNotificationSendgridTemplateId')
      ?.trim();
    this.sendgridTemplateId = templateId && templateId.length > 0 ? templateId : null;

    if (!this.busEventsUrl) {
      this.logger.warn(
        'BUS_API_URL is not configured. Phase change notifications are disabled.',
      );
    }

    if (!this.sendgridTemplateId) {
      this.logger.warn(
        'PHASE_NOTIFICATION_SENDGRID_TEMPLATE is not configured. Phase change notification emails are disabled.',
      );
    }
  }

  async sendPhaseChangeNotification(
    params: PhaseChangeNotificationParams,
  ): Promise<void> {
    if (!this.busEventsUrl) {
      return;
    }

    if (!this.sendgridTemplateId) {
      await this.dbLogger.logAction('notifications.phaseChange', {
        challengeId: params.challengeId,
        status: 'ERROR',
        source: PhaseChangeNotificationService.name,
        details: {
          phaseId: params.phaseId,
          operation: params.operation,
          error: 'PHASE_NOTIFICATION_SENDGRID_TEMPLATE is not configured.',
          stage: 'configuration',
        },
      });
      return;
    }

    const { challengeId, phaseId, operation } = params;

    let resources;
    try {
      resources = await this.resourcesService.getPhaseChangeNotificationResources(
        challengeId,
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to load phase change notification resources for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
      await this.dbLogger.logAction('notifications.phaseChange', {
        challengeId,
        status: 'ERROR',
        source: PhaseChangeNotificationService.name,
        details: {
          phaseId,
          operation,
          error: err.message,
          stage: 'load-resources',
        },
      });
      throw err;
    }

    if (!resources.length) {
      await this.dbLogger.logAction('notifications.phaseChange', {
        challengeId,
        status: 'INFO',
        source: PhaseChangeNotificationService.name,
        details: {
          phaseId,
          operation,
          note: 'No resources opted in for phase change notifications.',
        },
      });
      return;
    }

    const memberIds = resources.map((resource) => resource.memberId ?? '');
    const handles = resources.map((resource) => resource.memberHandle ?? '');

    let recipientEmails: string[] = [];
    try {
      const { idToEmail, handleToEmail } = await this.membersService.getMemberEmails({
        memberIds,
        handles,
      });

      const emailSet = new Set<string>();
      for (const resource of resources) {
        const normalizedId = resource.memberId?.trim();
        const normalizedHandle = resource.memberHandle?.trim().toLowerCase();

        const email =
          (normalizedId && idToEmail.get(normalizedId)) ||
          (normalizedHandle && handleToEmail.get(normalizedHandle));

        if (email) {
          emailSet.add(email.trim());
        }
      }

      recipientEmails = Array.from(emailSet);
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to resolve member emails for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
      await this.dbLogger.logAction('notifications.phaseChange', {
        challengeId,
        status: 'ERROR',
        source: PhaseChangeNotificationService.name,
        details: {
          phaseId,
          operation,
          error: err.message,
          stage: 'resolve-emails',
        },
      });
      throw err;
    }

    if (!recipientEmails.length) {
      await this.dbLogger.logAction('notifications.phaseChange', {
        challengeId,
        status: 'INFO',
        source: PhaseChangeNotificationService.name,
        details: {
          phaseId,
          operation,
          note: 'No email addresses resolved for opted-in resources.',
        },
      });
      return;
    }

    let challenge;
    try {
      challenge = await this.challengeApiService.getChallengeById(challengeId);
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to load challenge ${challengeId} when preparing notifications: ${err.message}`,
        err.stack,
      );
      await this.dbLogger.logAction('notifications.phaseChange', {
        challengeId,
        status: 'ERROR',
        source: PhaseChangeNotificationService.name,
        details: {
          phaseId,
          operation,
          error: err.message,
          stage: 'load-challenge',
        },
      });
      throw err;
    }

    if (!challenge) {
      await this.dbLogger.logAction('notifications.phaseChange', {
        challengeId,
        status: 'INFO',
        source: PhaseChangeNotificationService.name,
        details: {
          phaseId,
          operation,
          note: 'Challenge not found when preparing notifications.',
        },
      });
      return;
    }

    const phase = challenge.phases.find(
      (candidate) =>
        candidate.id === phaseId || candidate.phaseId === phaseId,
    );

    if (!phase) {
      await this.dbLogger.logAction('notifications.phaseChange', {
        challengeId,
        status: 'INFO',
        source: PhaseChangeNotificationService.name,
        details: {
          phaseId,
          operation,
          note: 'Phase not found on challenge after transition.',
        },
      });
      return;
    }

    const phaseOpenDateRaw =
      operation === 'open'
        ? phase.actualStartDate ?? new Date().toISOString()
        : null;
    const phaseCloseDateRaw =
      operation === 'close'
        ? phase.actualEndDate ?? new Date().toISOString()
        : null;

    const payloadData: NotificationPayloadData = {
      challengeName: challenge.name,
      challengeURL: this.buildChallengeUrl(challengeId),
      phaseOpen: operation === 'open' ? phase.name : null,
      phaseOpenDate: this.formatPhaseDate(phaseOpenDateRaw),
      phaseClose: operation === 'close' ? phase.name : null,
      phaseCloseDate: this.formatPhaseDate(phaseCloseDateRaw),
    };

    const defaultNotificationEmail = `no-reply@${this.emailDomain}.com`;

    const message = {
      topic: 'external.action.email',
      originator: this.originator,
      timestamp: new Date().toISOString(),
      'mime-type': 'application/json',
      payload: {
        from: defaultNotificationEmail,
        replyTo: defaultNotificationEmail,
        recipients: recipientEmails,
        data: payloadData,
        sendgrid_template_id: this.sendgridTemplateId,
        version: 'v3',
      },
    };

    try {
      const token = await this.auth0Service.getAccessToken();

      await firstValueFrom(
        this.httpService.post(this.busEventsUrl, message, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: this.timeoutMs,
        }),
      );

      await this.dbLogger.logAction('notifications.phaseChange', {
        challengeId,
        status: 'SUCCESS',
        source: PhaseChangeNotificationService.name,
        details: {
          phaseId,
          operation,
          recipients: recipientEmails.length,
          payload: payloadData,
        },
      });
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to publish phase change notification for challenge ${challengeId}: ${err.message}`,
        err.stack,
      );
      await this.dbLogger.logAction('notifications.phaseChange', {
        challengeId,
        status: 'ERROR',
        source: PhaseChangeNotificationService.name,
        details: {
          phaseId,
          operation,
          recipients: recipientEmails.length,
          error: err.message,
          stage: 'publish',
        },
      });
      throw err;
    }
  }

  private resolveReviewAppBaseUrl(): string {
    const configured = this.configService
      .get<string | null>('app.reviewAppUrl')
      ?.trim();

    if (configured && configured.length > 0) {
      return this.normalizeBaseUrl(configured);
    }

    const domain = this.resolveDefaultDomain();
    return `https://review.${domain}.com/`;
  }

  private resolveEmailDomain(baseUrl: string): string {
    try {
      const host = new URL(`${baseUrl}/`).hostname;
      const hostParts = host.split('.');
      if (hostParts.length >= 2) {
        return hostParts[hostParts.length - 2];
      }
    } catch (error) {
      this.logger.warn(
        `Unable to parse review app URL "${baseUrl}" for email domain resolution: ${(error as Error).message}`,
      );
    }

    return this.resolveDefaultDomain();
  }

  private resolveDefaultDomain(): string {
    const auth0Domain =
      this.configService.get<string>('auth0.domain')?.toLowerCase() ?? '';

    if (auth0Domain.includes('topcoder-dev')) {
      return 'topcoder-dev';
    }

    return 'topcoder';
  }

  private buildChallengeUrl(challengeId: string): string {
    const base = this.reviewAppBaseUrl.endsWith('/')
      ? this.reviewAppBaseUrl.slice(0, -1)
      : this.reviewAppBaseUrl;

    return `${base}/active-challenges/${challengeId}/challenge-details`;
  }

  private formatPhaseDate(value: string | Date | null | undefined): string | null {
    if (!value) {
      return null;
    }

    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
      this.logger.warn(
        `Unable to format phase date "${value}" for phase change notification payload.`,
      );

      return typeof value === 'string' ? value : null;
    }

    const parts = this.easternTimeFormatter.formatToParts(date);
    const getPartValue = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? '';

    const day = getPartValue('day');
    const month = getPartValue('month');
    const year = getPartValue('year');
    const hour = getPartValue('hour');
    const minute = getPartValue('minute');
    const timeZoneName = getPartValue('timeZoneName');

    if (!day || !month || !year || !hour || !minute || !timeZoneName) {
      return this.easternTimeFormatter.format(date);
    }

    return `${day}-${month}-${year} ${hour}:${minute} ${timeZoneName}`;
  }

  private normalizeBaseUrl(value: string): string {
    return value.endsWith('/') ? value.slice(0, -1) : value;
  }

  private buildEventsUrl(baseUrl: string): string {
    if (!baseUrl.endsWith('/')) {
      baseUrl = `${baseUrl}/`;
    }
    return new URL('v5/bus/events', baseUrl).toString();
  }
}
