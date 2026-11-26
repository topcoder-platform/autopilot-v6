import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { KafkaConnectionState, KafkaService } from '../kafka/kafka.service';
import { LoggerService } from '../common/services/logger.service';

@Injectable()
export class KafkaHealthIndicator {
  private readonly logger = new LoggerService(KafkaHealthIndicator.name);

  constructor(
    private readonly kafkaService: KafkaService,
    private readonly healthIndicator: HealthIndicatorService,
  ) {}

  async isHealthy(key: string) {
    const indicator = this.healthIndicator.check(key);
    const timestamp = new Date().toISOString();
    try {
      const status = this.kafkaService.getKafkaStatus();
      const details = {
        state: status.state,
        reconnectAttempts: status.reconnectAttempts,
        timestamp,
      };
      if (status.state === KafkaConnectionState.failed) {
        return indicator.down({
          ...details,
          reason: status.reason || 'Kafka reconnection attempts exhausted',
        });
      }
      if (!(await this.kafkaService.isConnected())) {
        return indicator.down({
          ...details,
          reason: status.reason || 'Kafka is not connected',
        });
      }
      return indicator.up(details);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error('Kafka health check failed', { reason, timestamp });
      return indicator.down({ reason, timestamp });
    }
  }
}
