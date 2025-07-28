import { Injectable, Logger } from '@nestjs/common';
import { KafkaService } from '../kafka.service';
import { AutopilotService } from '../../autopilot/services/autopilot.service';
import { KAFKA_TOPICS, KafkaTopic } from '../constants/topics';
import { KafkaMessage } from '../interfaces/kafka-message.interface';
import { TopicPayloadMap } from '../types/topic-payload-map.type';
import {
  ChallengeUpdatePayload,
  CommandPayload,
  PhaseTransitionPayload,
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
            case KAFKA_TOPICS.CHALLENGE_UPDATE:
            case KAFKA_TOPICS.CHALLENGE_UPDATED:
              await this.autopilotService.handleChallengeUpdate(
                payload as ChallengeUpdatePayload,
              );
              break;
            case KAFKA_TOPICS.COMMAND:
              this.autopilotService.handleCommand(payload as CommandPayload);
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
