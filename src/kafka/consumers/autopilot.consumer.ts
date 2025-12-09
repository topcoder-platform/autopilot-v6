import { Injectable, Logger } from '@nestjs/common';
import { KafkaService } from '../kafka.service';
import { AutopilotService } from '../../autopilot/services/autopilot.service';
import { KAFKA_TOPICS, KafkaTopic } from '../constants/topics';
import { KafkaMessage } from '../interfaces/kafka-message.interface';
import { TopicPayloadMap } from '../types/topic-payload-map.type';
import {
  ChallengeUpdatePayload,
  CommandPayload,
  AppealRespondedPayload,
  First2FinishSubmissionPayload,
  TopgearSubmissionPayload,
  PhaseTransitionPayload,
  ResourceEventPayload,
  ReviewCompletedPayload,
  SubmissionAggregatePayload,
} from 'src/autopilot/interfaces/autopilot.interface';

@Injectable()
export class AutopilotConsumer {
  private readonly logger = new Logger(AutopilotConsumer.name);

  public readonly topicHandlers: {
    [K in keyof TopicPayloadMap]: (
      message: TopicPayloadMap[K],
    ) => Promise<void>;
  };

  constructor(
    private readonly kafkaService: KafkaService,
    private readonly autopilotService: AutopilotService,
  ) {
    this.topicHandlers = {
      [KAFKA_TOPICS.PHASE_TRANSITION]:
        this.autopilotService.handlePhaseTransition.bind(
          this.autopilotService,
        ) as (message: PhaseTransitionPayload) => Promise<void>,
      [KAFKA_TOPICS.CHALLENGE_CREATED]:
        this.autopilotService.handleNewChallenge.bind(
          this.autopilotService,
        ) as (message: ChallengeUpdatePayload) => Promise<void>,
      [KAFKA_TOPICS.CHALLENGE_UPDATE]:
        this.autopilotService.handleChallengeUpdate.bind(
          this.autopilotService,
        ) as (message: ChallengeUpdatePayload) => Promise<void>,
      [KAFKA_TOPICS.CHALLENGE_UPDATED]:
        this.autopilotService.handleChallengeUpdate.bind(
          this.autopilotService,
        ) as (message: ChallengeUpdatePayload) => Promise<void>,
      [KAFKA_TOPICS.COMMAND]: this.autopilotService.handleCommand.bind(
        this.autopilotService,
      ) as (message: CommandPayload) => Promise<void>,
      [KAFKA_TOPICS.SUBMISSION_NOTIFICATION_AGGREGATE]:
        this.autopilotService.handleSubmissionNotificationAggregate.bind(
          this.autopilotService,
        ) as (message: SubmissionAggregatePayload) => Promise<void>,
      [KAFKA_TOPICS.RESOURCE_CREATED]:
        this.autopilotService.handleResourceCreated.bind(
          this.autopilotService,
        ) as (message: ResourceEventPayload) => Promise<void>,
      [KAFKA_TOPICS.RESOURCE_DELETED]:
        this.autopilotService.handleResourceDeleted.bind(
          this.autopilotService,
        ) as (message: ResourceEventPayload) => Promise<void>,
      [KAFKA_TOPICS.REVIEW_COMPLETED]:
        this.autopilotService.handleReviewCompleted.bind(
          this.autopilotService,
        ) as (message: ReviewCompletedPayload) => Promise<void>,
      [KAFKA_TOPICS.REVIEW_APPEAL_RESPONDED]:
        this.autopilotService.handleAppealResponded.bind(
          this.autopilotService,
        ) as (message: AppealRespondedPayload) => Promise<void>,
      [KAFKA_TOPICS.FIRST2FINISH_SUBMISSION_RECEIVED]:
        this.autopilotService.handleFirst2FinishSubmission.bind(
          this.autopilotService,
        ) as (message: First2FinishSubmissionPayload) => Promise<void>,
      [KAFKA_TOPICS.TOPGEAR_SUBMISSION_RECEIVED]:
        this.autopilotService.handleTopgearSubmission.bind(
          this.autopilotService,
        ) as (message: TopgearSubmissionPayload) => Promise<void>,
    };
  }

  async startConsumer(groupId: string): Promise<void> {
    const topics = Object.values(KAFKA_TOPICS);

    await this.kafkaService.consume(
      groupId,
      topics,
      async (message: KafkaMessage<KafkaTopic>) => {
        try {
          const { topic, payload } = message;

          switch (topic) {
            case KAFKA_TOPICS.PHASE_TRANSITION:
              this.autopilotService.handlePhaseTransition(
                payload as PhaseTransitionPayload,
              );
              break;
            case KAFKA_TOPICS.CHALLENGE_CREATED:
              await this.autopilotService.handleNewChallenge(
                payload as ChallengeUpdatePayload,
              );
              break;
            case KAFKA_TOPICS.CHALLENGE_UPDATE:
            case KAFKA_TOPICS.CHALLENGE_UPDATED:
              await this.autopilotService.handleChallengeUpdate(
                payload as ChallengeUpdatePayload,
              );
              break;
            case KAFKA_TOPICS.COMMAND:
              await this.autopilotService.handleCommand(
                payload as CommandPayload,
              );
              break;
            case KAFKA_TOPICS.SUBMISSION_NOTIFICATION_AGGREGATE:
              await this.autopilotService.handleSubmissionNotificationAggregate(
                payload as SubmissionAggregatePayload,
              );
              break;
            case KAFKA_TOPICS.RESOURCE_CREATED:
              await this.autopilotService.handleResourceCreated(
                payload as ResourceEventPayload,
              );
              break;
            case KAFKA_TOPICS.RESOURCE_DELETED:
              await this.autopilotService.handleResourceDeleted(
                payload as ResourceEventPayload,
              );
              break;
            case KAFKA_TOPICS.REVIEW_COMPLETED:
              await this.autopilotService.handleReviewCompleted(
                payload as ReviewCompletedPayload,
              );
              break;
            case KAFKA_TOPICS.REVIEW_APPEAL_RESPONDED:
              await this.autopilotService.handleAppealResponded(
                payload as AppealRespondedPayload,
              );
              break;
            case KAFKA_TOPICS.FIRST2FINISH_SUBMISSION_RECEIVED:
              await this.autopilotService.handleFirst2FinishSubmission(
                payload as First2FinishSubmissionPayload,
              );
              break;
            case KAFKA_TOPICS.TOPGEAR_SUBMISSION_RECEIVED:
              await this.autopilotService.handleTopgearSubmission(
                payload as TopgearSubmissionPayload,
              );
              break;
            default:
              throw new Error(`Unexpected topic: ${topic as string}`);
          }
        } catch (error: unknown) {
          const err = error as Error;
          this.logger.error(
            `Error processing message for topic ${message.topic}`,
            {
              error: err.stack,
              message,
            },
          );
        }
      },
    );
  }
}
