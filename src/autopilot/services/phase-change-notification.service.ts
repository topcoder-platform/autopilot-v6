import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as cityTimezones from 'city-timezones';
import * as moment from 'moment-timezone';
import { ResourcesService } from '../../resources/resources.service';
import type { ReviewerResourceRecord } from '../../resources/resources.service';
import { MembersService } from '../../members/members.service';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import type { IChallenge } from '../../challenge/interfaces/challenge.interface';
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
  localized_time: string;
  phase_change: string;
}

interface NotificationRecipient {
  email: string;
  city: string | null;
  homeCountryCode: string | null;
  competitionCountryCode: string | null;
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
    this.sendgridTemplateId =
      templateId && templateId.length > 0 ? templateId : null;

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

  /**
   * Publishes one phase-change email event for each unique opted-in recipient.
   *
   * @param params Challenge phase and operation that triggered the notification.
   * @returns A promise that resolves after every recipient event is accepted.
   * @throws Resource, member, challenge, authentication, or Bus API errors.
   */
  async sendPhaseChangeNotification(
    params: PhaseChangeNotificationParams,
  ): Promise<void> {
    if (!this.busEventsUrl) {
      return;
    }
    const busEventsUrl = this.busEventsUrl;

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

    let resources: ReviewerResourceRecord[] = [];
    try {
      resources =
        await this.resourcesService.getPhaseChangeNotificationResources(
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

    let recipients: NotificationRecipient[] = [];
    try {
      const { idToMember, handleToMember } =
        await this.membersService.getMemberEmails({
          memberIds,
          handles,
        });

      const recipientMap = new Map<string, NotificationRecipient>();
      for (const resource of resources) {
        const normalizedId = resource.memberId?.trim();
        const normalizedHandle = resource.memberHandle?.trim().toLowerCase();

        const member =
          (normalizedId ? idToMember.get(normalizedId) : undefined) ??
          (normalizedHandle ? handleToMember.get(normalizedHandle) : undefined);
        const email = member?.email.trim();

        if (member && email) {
          const normalizedEmail = email.toLowerCase();
          if (!recipientMap.has(normalizedEmail)) {
            recipientMap.set(normalizedEmail, {
              email,
              city: member.city,
              homeCountryCode: member.homeCountryCode,
              competitionCountryCode: member.competitionCountryCode,
            });
          }
        }
      }

      recipients = Array.from(recipientMap.values());
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

    if (!recipients.length) {
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

    let challenge: IChallenge | null = null;
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
      (candidate) => candidate.id === phaseId || candidate.phaseId === phaseId,
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

    const phaseDateRaw =
      operation === 'open'
        ? (phase.actualStartDate ?? new Date().toISOString())
        : (phase.actualEndDate ?? new Date().toISOString());
    const phaseChange = `${phase.name} ${
      operation === 'open' ? 'Open' : 'Closed'
    }`;

    const defaultNotificationEmail = `no-reply@${this.emailDomain}.com`;
    const messages = recipients.map((recipient) => {
      const localizedTime = this.formatPhaseDate(
        phaseDateRaw,
        this.resolveTimeZone(recipient),
      );
      const payloadData: NotificationPayloadData = {
        challengeName: challenge.name,
        challengeURL: this.buildChallengeUrl(challengeId),
        phaseOpen: operation === 'open' ? phase.name : null,
        phaseOpenDate: operation === 'open' ? localizedTime : null,
        phaseClose: operation === 'close' ? phase.name : null,
        phaseCloseDate: operation === 'close' ? localizedTime : null,
        localized_time: localizedTime,
        phase_change: phaseChange,
      };

      return {
        topic: 'external.action.email',
        originator: this.originator,
        timestamp: new Date().toISOString(),
        'mime-type': 'application/json',
        payload: {
          from: defaultNotificationEmail,
          replyTo: defaultNotificationEmail,
          recipients: [recipient.email],
          data: payloadData,
          sendgrid_template_id: this.sendgridTemplateId,
          version: 'v3',
        },
      };
    });

    try {
      const token = await this.auth0Service.getAccessToken();

      await Promise.all(
        messages.map((message) =>
          firstValueFrom(
            this.httpService.post(busEventsUrl, message, {
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              timeout: this.timeoutMs,
            }),
          ),
        ),
      );

      await this.dbLogger.logAction('notifications.phaseChange', {
        challengeId,
        status: 'SUCCESS',
        source: PhaseChangeNotificationService.name,
        details: {
          phaseId,
          operation,
          recipients: recipients.length,
          payloads: messages.map((message) => message.payload.data),
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
          recipients: recipients.length,
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

  /**
   * Resolves the member's profile city to the same IANA timezone used by the
   * profile application.
   *
   * @param recipient Member city and country codes from the saved profile.
   * @returns The first matching IANA timezone, or UTC when none is available.
   * @throws Never. Missing and unrecognized cities use UTC.
   */
  private resolveTimeZone(recipient: NotificationRecipient): string {
    const city = recipient.city;
    if (!city) {
      return 'UTC';
    }

    const timeZone = cityTimezones.lookupViaCity(city)[0]?.timezone;
    if (timeZone && moment.tz.zone(timeZone)) {
      return timeZone;
    }

    const countryCode =
      recipient.homeCountryCode || recipient.competitionCountryCode;
    const country = countryCode
      ? cityTimezones.findFromIsoCode(countryCode)[0]?.country
      : null;
    const profileFallbackTimeZone = country ? `${country}/${city}` : null;

    return profileFallbackTimeZone && moment.tz.zone(profileFallbackTimeZone)
      ? profileFallbackTimeZone
      : 'UTC';
  }

  /**
   * Formats a phase transition timestamp in a member's resolved timezone.
   *
   * @param value Phase transition timestamp.
   * @param timeZone IANA timezone resolved from the member profile.
   * @returns A readable localized timestamp, or the original invalid value.
   * @throws Never. Invalid timestamps are returned unchanged.
   */
  private formatPhaseDate(value: string | Date, timeZone: string): string {
    const date = moment(value);

    if (!date.isValid()) {
      this.logger.warn(
        `Unable to format phase date "${String(value)}" for phase change notification payload.`,
      );

      return String(value);
    }

    return date.tz(timeZone).format('MMMM DD, YYYY HH:mm z');
  }

  private normalizeBaseUrl(value: string): string {
    return value.endsWith('/') ? value.slice(0, -1) : value;
  }

  private buildEventsUrl(baseUrl: string): string {
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/events`;
    return url.toString();
  }
}
