import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthCheckError } from '@nestjs/terminus';
import { KafkaConnectionState, KafkaService } from '../kafka/kafka.service';
import { LoggerService } from '../common/services/logger.service';

@Injectable()
export class KafkaHealthIndicator extends HealthIndicator {
  private readonly logger = new LoggerService(KafkaHealthIndicator.name);

  constructor(private readonly kafkaService: KafkaService) {
    super();
  }

  async isHealthy(key: string) {
    try {
      const status = this.kafkaService.getKafkaStatus();
      const timestamp = new Date().toISOString();

      if (status.state === KafkaConnectionState.failed) {
        throw new HealthCheckError(
          'KafkaHealthCheck failed',
          this.getStatus(key, false, {
            state: status.state,
            reconnectAttempts: status.reconnectAttempts,
            reason: status.reason || 'Kafka reconnection attempts exhausted',
            timestamp,
          }),
        );
      }

      const isConnected = await this.kafkaService.isConnected();

      if (!isConnected) {
        throw new HealthCheckError(
          'KafkaHealthCheck failed',
          this.getStatus(key, false, {
            state: status.state,
            reconnectAttempts: status.reconnectAttempts,
            reason: status.reason || 'Kafka is not connected',
            timestamp,
          }),
        );
      }

      return this.getStatus(key, true, {
        state: status.state,
        reconnectAttempts: status.reconnectAttempts,
        timestamp,
      });
    } catch (error: unknown) {
      const err = error as Error;

      this.logger.error('Kafka health check failed', {
        error: err.stack,
        timestamp: new Date().toISOString(),
      });

      throw new HealthCheckError(
        'KafkaHealthCheck failed',
        this.getStatus(key, false, {
          reason: err.message,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
}
