import { Injectable } from '@nestjs/common';
import { KafkaService } from '../kafka.service';
import {
  PhaseTransitionPayload,
  PhaseTransitionMessage,
  ChallengeUpdatePayload,
  ChallengeUpdateMessage,
  CommandPayload,
  CommandMessage,
} from '../templates/autopilot.template';

@Injectable()
export class AutopilotProducer {
  constructor(private readonly kafkaService: KafkaService) {}

  async sendPhaseTransition(payload: PhaseTransitionPayload): Promise<void> {
    const message = new PhaseTransitionMessage({
      ...payload,
      date: payload.date || new Date().toISOString(),
    });
    await this.kafkaService.produce(message.topic, message);
  }

  async sendChallengeUpdate(payload: ChallengeUpdatePayload): Promise<void> {
    const message = new ChallengeUpdateMessage({
      ...payload,
      date: payload.date || new Date().toISOString(),
    });
    await this.kafkaService.produce(message.topic, message);
  }

  async sendCommand(payload: CommandPayload): Promise<void> {
    const message = new CommandMessage({
      ...payload,
      date: payload.date || new Date().toISOString(),
    });
    await this.kafkaService.produce(message.topic, message);
  }
}
