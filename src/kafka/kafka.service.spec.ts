import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import { KafkaConnectionException } from '../common/exceptions/kafka.exception';
import kafkaConfig from '../config/sections/kafka.config';
import { KafkaConnectionState, KafkaService } from './kafka.service';

jest.mock('../common/services/logger.service', () => ({
  LoggerService: jest.fn().mockImplementation(() => ({
    error: jest.fn(),
    info: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
  })),
}));

type MessageDouble = {
  commit: jest.Mock<Promise<void>, []>;
  headers: Map<string, string>;
  key: string;
  metadata: Record<string, unknown>;
  offset: bigint;
  partition: number;
  timestamp: bigint;
  topic: string;
  value: unknown;
};

type StreamDouble = EventEmitter &
  AsyncIterable<MessageDouble> & {
    close: jest.Mock<Promise<void>, []>;
  };

const consumerInstances: ConsumerDouble[] = [];
const producerInstances: ProducerDouble[] = [];
const queuedStreams: StreamDouble[] = [];
const queuedProducerMetadataErrors: Error[] = [];

/**
 * Minimal event-emitting Platformatic consumer used by lifecycle tests.
 *
 * Instances retain constructor and consume options so tests can verify the
 * exact values passed to Platformatic without opening broker connections.
 */
class ConsumerDouble extends EventEmitter {
  /** Resolves consumer shutdown by default. */
  readonly close = jest.fn<Promise<void>, [boolean?]>().mockResolvedValue();

  /** Reports a connected client to health checks. */
  readonly isConnected = jest.fn<boolean, []>().mockReturnValue(true);

  /**
   * Creates the next queued stream for a subscription.
   *
   * @param options Subscription options supplied by KafkaService.
   * @returns The next finite stream queued by the test.
   */
  readonly consume = jest
    .fn<Promise<StreamDouble>, [Record<string, unknown>]>()
    .mockImplementation(async () => queuedStreams.shift() ?? createStream([]));

  /**
   * Records the Platformatic consumer constructor options.
   *
   * @param options Consumer options passed by KafkaService.
   */
  constructor(readonly options: Record<string, unknown>) {
    super();
    consumerInstances.push(this);
  }
}

/**
 * Minimal event-emitting Platformatic producer used by lifecycle tests.
 *
 * The double supports metadata, sends, connectivity checks, and forced close.
 */
class ProducerDouble extends EventEmitter {
  /** Resolves producer shutdown by default. */
  readonly close = jest.fn<Promise<void>, [boolean?]>().mockResolvedValue();

  /** Reports a connected client to health checks. */
  readonly isConnected = jest.fn<boolean, []>().mockReturnValue(true);

  /** Resolves metadata discovery by default. */
  readonly metadata = jest
    .fn<Promise<unknown>, [Record<string, unknown>]>()
    .mockImplementation(async () => {
      const error = queuedProducerMetadataErrors.shift();
      if (error) {
        this.emit('error', error);
      }
      return new Map();
    });

  /** Resolves message sends by default. */
  readonly send = jest
    .fn<Promise<unknown>, [Record<string, unknown>]>()
    .mockResolvedValue({});

  /**
   * Records the Platformatic producer constructor options.
   *
   * @param options Producer options passed by KafkaService.
   */
  constructor(readonly options: Record<string, unknown>) {
    super();
    producerInstances.push(this);
  }
}

const jsonDeserializer = jest.fn();
const jsonSerializer = jest.fn();
const stringDeserializer = jest.fn();
const stringSerializer = jest.fn();

const kafkaModuleDouble = {
  Consumer: ConsumerDouble,
  Producer: ProducerDouble,
  ProduceAcks: { ALL: -1 },
  jsonDeserializer,
  jsonSerializer,
  stringDeserializer,
  stringSerializer,
};

/**
 * Creates a finite Platformatic-like message stream.
 *
 * @param messages Messages yielded in order before the stream ends.
 * @returns An event-emitting async iterable with an asynchronous close method.
 */
function createStream(messages: MessageDouble[]): StreamDouble {
  const stream = Object.assign(new EventEmitter(), {
    close: jest.fn<Promise<void>, []>().mockResolvedValue(),
  }) as StreamDouble;

  stream[Symbol.asyncIterator] = async function* () {
    yield* messages;
  };

  return stream;
}

/**
 * Creates the ConfigService subset read by KafkaService.
 *
 * @param overrides Optional Kafka values keyed by their Nest config paths.
 * @returns A ConfigService test double with safe production defaults.
 */
function createConfigService(
  overrides: Record<string, unknown> = {},
): ConfigService {
  const values: Record<string, unknown> = {
    'kafka.brokers': 'broker-1:9092,broker-2:9092',
    'kafka.clientId': 'autopilot-test',
    'kafka.connectionTimeout': 11000,
    'kafka.requestTimeout': 31000,
    'kafka.brokerTimeout': 7000,
    'kafka.sessionTimeout': 65000,
    'kafka.heartbeatInterval': 3000,
    'kafka.maxWaitTime': 5000,
    'kafka.retry.initialRetryTime': 100,
    'kafka.retry.retries': 3,
    'kafka.retry.maxRetryTime': 30000,
    ...overrides,
  };

  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

/**
 * Creates a KafkaService using the in-memory Platformatic module.
 *
 * @param overrides Optional Kafka configuration overrides.
 * @returns A service whose clients never open network connections.
 * @throws {KafkaConnectionException} When supplied timing values are invalid.
 */
function createService(overrides: Record<string, unknown> = {}): KafkaService {
  return new KafkaService(
    createConfigService(overrides),
    async () => kafkaModuleDouble as never,
  );
}

/**
 * Exposes the private lifecycle surface required for focused unit tests.
 *
 * @param service KafkaService under test.
 * @returns Typed access to client construction and recovery helpers.
 */
function getInternals(service: KafkaService) {
  return service as unknown as {
    closeConsumer: (groupId: string) => Promise<void>;
    closeProducer: () => Promise<void>;
    consumers: Map<string, ConsumerDouble>;
    consumerStreams: Map<string, StreamDouble>;
    createProducer: () => Promise<ProducerDouble>;
    getOrCreateConsumer: (groupId: string) => Promise<ConsumerDouble>;
    getReconnectDelay: (attempt: number) => number;
    reconnectCandidateActive: boolean;
    restartKafkaClients: (trackReplacementFailures?: boolean) => Promise<void>;
    scheduleReconnect: (queue?: boolean) => Promise<void>;
    startConsumerLoop: (
      groupId: string,
      topics: string[],
      stream: StreamDouble,
      onMessage: (message: unknown) => Promise<void>,
    ) => Promise<void>;
    streamErrorListeners: Map<string, (error: Error) => void>;
  };
}

/**
 * Extracts the underlying validation reason from a wrapped constructor error.
 *
 * @param overrides Invalid Kafka configuration values.
 * @returns The detailed timing-validation error recorded on the exception.
 * @throws {Error} If service construction unexpectedly succeeds.
 */
function getConfigurationFailure(overrides: Record<string, unknown>): string {
  try {
    createService(overrides);
  } catch (error) {
    expect(error).toBeInstanceOf(KafkaConnectionException);
    const kafkaError = error as KafkaConnectionException;
    return String(kafkaError.details?.error);
  }

  throw new Error('Expected KafkaService configuration to fail');
}

describe('KafkaService Platformatic 2.8 configuration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    consumerInstances.length = 0;
    producerInstances.length = 0;
    queuedStreams.length = 0;
    queuedProducerMetadataErrors.length = 0;
  });

  it('maps transport, broker, group, and retry timings independently', async () => {
    const service = createService({
      'kafka.brokers': ' broker-1:9092, broker-2:9092 ',
    });
    const internals = getInternals(service);

    await internals.createProducer();
    await internals.getOrCreateConsumer('autopilot-group');

    expect(producerInstances[0].options).toEqual({
      clientId: 'autopilot-test',
      bootstrapBrokers: ['broker-1:9092', 'broker-2:9092'],
      idempotent: true,
      acks: -1,
      connectTimeout: 11000,
      requestTimeout: 31000,
      timeout: 7000,
      retries: 3,
      retryDelay: 100,
      maxInflights: 5,
      serializers: {
        key: stringSerializer,
        value: jsonSerializer,
        headerKey: stringSerializer,
        headerValue: stringSerializer,
      },
    });
    expect(consumerInstances[0].options).toEqual({
      clientId: 'autopilot-test-autopilot-group',
      groupId: 'autopilot-group',
      bootstrapBrokers: ['broker-1:9092', 'broker-2:9092'],
      autocommit: false,
      connectTimeout: 11000,
      requestTimeout: 31000,
      timeout: 7000,
      sessionTimeout: 65000,
      heartbeatInterval: 3000,
      retries: 3,
      retryDelay: 100,
      maxWaitTime: 5000,
      maxBytes: 5 * 1024 * 1024,
      deserializers: {
        key: stringDeserializer,
        value: jsonDeserializer,
        headerKey: stringDeserializer,
        headerValue: stringDeserializer,
      },
    });
  });

  it('rejects malformed and racing timeout values', () => {
    expect(
      getConfigurationFailure({ 'kafka.connectionTimeout': Number.NaN }),
    ).toContain('Kafka connectionTimeout must be a positive integer');
    expect(getConfigurationFailure({ 'kafka.requestTimeout': 5000 })).toContain(
      'Kafka maxWaitTime must be less than requestTimeout',
    );
    expect(
      getConfigurationFailure({ 'kafka.sessionTimeout': 34000 }),
    ).toContain(
      'Kafka heartbeatInterval plus requestTimeout must be less than sessionTimeout',
    );
  });

  it('adds bounded jitter to reconnection backoff', () => {
    const internals = getInternals(createService());
    const random = jest.spyOn(Math, 'random');

    random.mockReturnValueOnce(0).mockReturnValueOnce(0.9999);

    expect(internals.getReconnectDelay(3)).toBe(200);
    expect(internals.getReconnectDelay(3)).toBe(400);

    random.mockRestore();
  });
});

describe('KafkaService recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    consumerInstances.length = 0;
    producerInstances.length = 0;
    queuedStreams.length = 0;
    queuedProducerMetadataErrors.length = 0;
  });

  it('routes consumer and producer client errors through shared recovery', async () => {
    const service = createService();
    const internals = getInternals(service);
    const scheduleReconnect = jest
      .spyOn(internals, 'scheduleReconnect')
      .mockResolvedValue();
    const consumer = await internals.getOrCreateConsumer('autopilot-group');
    const producer = await internals.createProducer();

    consumer.emit('error', new Error('consumer coordinator failed'));

    expect(service.getKafkaStatus()).toMatchObject({
      state: KafkaConnectionState.reconnecting,
      reason: expect.stringContaining('consumer coordinator failed'),
    });

    producer.emit('error', new Error('producer connection failed'));

    expect(service.getKafkaStatus()).toMatchObject({
      state: KafkaConnectionState.reconnecting,
      reason: expect.stringContaining('producer connection failed'),
    });
    expect(scheduleReconnect).toHaveBeenCalledTimes(2);
  });

  it('stops the stream when an offset commit fails during recovery', async () => {
    const service = createService();
    const internals = getInternals(service);
    const scheduleReconnect = jest
      .spyOn(internals, 'scheduleReconnect')
      .mockResolvedValue();
    const onMessage = jest.fn<Promise<void>, [unknown]>().mockResolvedValue();
    const firstMessage: MessageDouble = {
      commit: jest
        .fn<Promise<void>, []>()
        .mockRejectedValue(new Error('offset commit timed out')),
      headers: new Map(),
      key: 'message-key',
      metadata: {},
      offset: 12n,
      partition: 0,
      timestamp: 1n,
      topic: 'challenge.notification.update',
      value: { id: 'challenge-id' },
    };
    const secondMessage: MessageDouble = {
      ...firstMessage,
      commit: jest.fn<Promise<void>, []>().mockResolvedValue(),
      offset: 13n,
      value: { id: 'later-challenge-id' },
    };

    await internals.startConsumerLoop(
      'autopilot-group',
      [firstMessage.topic],
      createStream([firstMessage, secondMessage]),
      onMessage,
    );

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(firstMessage.value);
    expect(firstMessage.commit).toHaveBeenCalledTimes(1);
    expect(secondMessage.commit).not.toHaveBeenCalled();
    expect(service.getKafkaStatus()).toMatchObject({
      state: KafkaConnectionState.reconnecting,
      reason: expect.stringContaining('offset commit timed out'),
    });
    expect(scheduleReconnect).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the producer and every configured consumer group', async () => {
    const service = createService();
    const internals = getInternals(service);
    queuedStreams.push(
      createStream([]),
      createStream([]),
      createStream([]),
      createStream([]),
    );

    await service.onModuleInit();
    await service.consume('autopilot-group-a', ['topic-a'], async () => {});
    await service.consume('autopilot-group-b', ['topic-b'], async () => {});

    expect(producerInstances).toHaveLength(1);
    expect(consumerInstances).toHaveLength(2);

    await internals.restartKafkaClients();

    expect(producerInstances).toHaveLength(2);
    expect(consumerInstances).toHaveLength(4);
    expect(consumerInstances[2].consume).toHaveBeenCalledWith({
      topics: ['topic-a'],
      autocommit: false,
      mode: 'committed',
      fallbackMode: 'latest',
    });
    expect(consumerInstances[3].consume).toHaveBeenCalledWith({
      topics: ['topic-b'],
      autocommit: false,
      mode: 'committed',
      fallbackMode: 'latest',
    });
  });

  it('commits in-flight work before closing an old reconnect consumer', async () => {
    const service = createService();
    const internals = getInternals(service);
    const lifecycleOrder: string[] = [];
    let markProcessingStarted = (): void => undefined;
    let releaseProcessing = (): void => undefined;
    const processingStarted = new Promise<void>((resolve) => {
      markProcessingStarted = resolve;
    });
    const processingRelease = new Promise<void>((resolve) => {
      releaseProcessing = resolve;
    });
    const message: MessageDouble = {
      commit: jest.fn<Promise<void>, []>().mockImplementation(async () => {
        lifecycleOrder.push('commit');
      }),
      headers: new Map(),
      key: 'message-key',
      metadata: {},
      offset: 18n,
      partition: 0,
      timestamp: 1n,
      topic: 'challenge.notification.update',
      value: { id: 'challenge-id' },
    };
    queuedStreams.push(createStream([message]), createStream([]));

    await service.onModuleInit();
    await service.consume(
      'autopilot-group',
      [message.topic],
      async (): Promise<void> => {
        markProcessingStarted();
        await processingRelease;
      },
    );
    await processingStarted;

    const originalConsumer = consumerInstances[0];
    originalConsumer.close.mockImplementation(async () => {
      expect(internals.reconnectCandidateActive).toBe(false);
      lifecycleOrder.push('consumer-close');
    });

    const restart = internals.restartKafkaClients(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(originalConsumer.close).not.toHaveBeenCalled();

    releaseProcessing();
    await restart;

    expect(lifecycleOrder).toEqual(['commit', 'consumer-close']);
    expect(internals.reconnectCandidateActive).toBe(true);
  });

  it('retries when a replacement client fails before Kafka becomes ready', async () => {
    const service = createService();
    const internals = getInternals(service);
    jest.spyOn(internals, 'getReconnectDelay').mockReturnValue(0);
    queuedStreams.push(createStream([]), createStream([]), createStream([]));

    await service.onModuleInit();
    await service.consume('autopilot-group', ['topic-a'], async () => {});
    queuedProducerMetadataErrors.push(
      new Error('replacement producer disconnected'),
    );

    await internals.scheduleReconnect();

    expect(producerInstances).toHaveLength(3);
    expect(producerInstances[1].close).toHaveBeenCalledWith(true);
    expect(service.getKafkaStatus()).toMatchObject({
      state: KafkaConnectionState.ready,
      reconnectAttempts: 0,
      reason: undefined,
    });
  });

  it('contains late errors after stream and client closes fail', async () => {
    const service = createService();
    const internals = getInternals(service);
    const scheduleReconnect = jest
      .spyOn(internals, 'scheduleReconnect')
      .mockResolvedValue();
    await service.onModuleInit();
    const producer = producerInstances[0];
    producer.close.mockRejectedValueOnce(new Error('producer close failed'));
    const consumer = await internals.getOrCreateConsumer('autopilot-group');
    consumer.close.mockRejectedValueOnce(new Error('consumer close failed'));
    const stream = createStream([]);
    const streamErrorListener = jest.fn();
    stream.on('error', streamErrorListener);
    stream.close.mockRejectedValueOnce(new Error('stream close failed'));
    internals.consumerStreams.set('autopilot-group', stream);
    internals.streamErrorListeners.set('autopilot-group', streamErrorListener);

    await internals.closeConsumer('autopilot-group');
    await internals.closeProducer();

    expect(internals.consumers.has('autopilot-group')).toBe(false);
    expect(() =>
      consumer.emit('error', new Error('detached client error')),
    ).not.toThrow();
    expect(() =>
      stream.emit('error', new Error('detached stream error')),
    ).not.toThrow();
    expect(() =>
      producer.emit('error', new Error('detached producer error')),
    ).not.toThrow();
    expect(streamErrorListener).not.toHaveBeenCalled();
    expect(scheduleReconnect).not.toHaveBeenCalled();
  });
});

describe('Kafka environment configuration', () => {
  const timingVariables = [
    'KAFKA_CONNECTION_TIMEOUT',
    'KAFKA_REQUEST_TIMEOUT',
    'KAFKA_BROKER_TIMEOUT',
    'KAFKA_SESSION_TIMEOUT',
    'KAFKA_HEARTBEAT_INTERVAL',
    'KAFKA_MAX_WAIT_TIME',
  ] as const;
  const originalValues = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const variable of timingVariables) {
      originalValues.set(variable, process.env[variable]);
    }
  });

  afterAll(() => {
    for (const [variable, value] of originalValues) {
      if (value === undefined) {
        delete process.env[variable];
      } else {
        process.env[variable] = value;
      }
    }
  });

  it('maps every timing environment variable independently', () => {
    process.env.KAFKA_CONNECTION_TIMEOUT = '12000';
    process.env.KAFKA_REQUEST_TIMEOUT = '40000';
    process.env.KAFKA_BROKER_TIMEOUT = '6000';
    process.env.KAFKA_SESSION_TIMEOUT = '70000';
    process.env.KAFKA_HEARTBEAT_INTERVAL = '4000';
    process.env.KAFKA_MAX_WAIT_TIME = '8000';

    expect(kafkaConfig()).toMatchObject({
      connectionTimeout: 12000,
      requestTimeout: 40000,
      brokerTimeout: 6000,
      sessionTimeout: 70000,
      heartbeatInterval: 4000,
      maxWaitTime: 8000,
    });
  });
});
