import { HealthCheckError } from '@nestjs/terminus';
import { KafkaHealthIndicator } from './kafka.health';
import { KafkaConnectionState, KafkaService } from '../kafka/kafka.service';

jest.mock('../kafka/kafka.service', () => {
  const KafkaConnectionStateMock = {
    initializing: 'initializing',
    ready: 'ready',
    reconnecting: 'reconnecting',
    failed: 'failed',
    disabled: 'disabled',
  } as const;

  class KafkaServiceMock {
    isConnected = jest.fn();
    getKafkaStatus = jest.fn();
  }

  return {
    KafkaConnectionState: KafkaConnectionStateMock,
    KafkaService: KafkaServiceMock,
  };
});

jest.mock('@platformatic/kafka', () => {
  class MockConsumer {
    consume = jest.fn();
    isConnected = jest.fn().mockReturnValue(true);
    close = jest.fn();
    on = jest.fn();
  }

  class MockProducer {
    metadata = jest.fn();
    send = jest.fn();
    close = jest.fn();
    isConnected = jest.fn().mockReturnValue(true);
  }

  return {
    Consumer: MockConsumer,
    Producer: MockProducer,
    MessagesStream: class {},
    ProduceAcks: { ALL: 'all' },
    jsonDeserializer: jest.fn(),
    jsonSerializer: jest.fn(),
    stringDeserializer: jest.fn(),
    stringSerializer: jest.fn(),
  };
});

describe('KafkaHealthIndicator', () => {
  let kafkaService: jest.Mocked<
    Pick<KafkaService, 'isConnected' | 'getKafkaStatus'>
  >;
  let indicator: KafkaHealthIndicator;

  beforeEach(() => {
    kafkaService = {
      isConnected: jest.fn(),
      getKafkaStatus: jest.fn(),
    } as unknown as jest.Mocked<
      Pick<KafkaService, 'isConnected' | 'getKafkaStatus'>
    >;

    indicator = new KafkaHealthIndicator(
      kafkaService as unknown as KafkaService,
    );
  });

  it('returns a healthy status when Kafka is connected', async () => {
    kafkaService.getKafkaStatus.mockReturnValue({
      state: KafkaConnectionState.ready,
      reconnectAttempts: 0,
    });
    kafkaService.isConnected.mockResolvedValue(true);

    const result = await indicator.isHealthy('kafka');

    expect(result.kafka.status).toBe('up');
    expect(result.kafka.state).toBe(KafkaConnectionState.ready);
    expect(result.kafka.reconnectAttempts).toBe(0);
  });

  it('throws when Kafka state is failed', async () => {
    kafkaService.getKafkaStatus.mockReturnValue({
      state: KafkaConnectionState.failed,
      reconnectAttempts: 3,
      reason: 'Kafka reconnection attempts exhausted',
    });

    await expect(indicator.isHealthy('kafka')).rejects.toBeInstanceOf(
      HealthCheckError,
    );
    expect(kafkaService.isConnected).not.toHaveBeenCalled();
  });

  it('throws when Kafka connections are not ready', async () => {
    kafkaService.getKafkaStatus.mockReturnValue({
      state: KafkaConnectionState.ready,
      reconnectAttempts: 1,
      reason: 'Kafka is not connected',
    });
    kafkaService.isConnected.mockResolvedValue(false);

    await expect(indicator.isHealthy('kafka')).rejects.toBeInstanceOf(
      HealthCheckError,
    );
  });
});
