import {
  Inject,
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  Consumer,
  Message,
  MessagesStream,
  Producer,
} from '@platformatic/kafka';
import { randomUUID as uuidv4 } from 'node:crypto';

import {
  KafkaConnectionException,
  KafkaConsumerException,
  KafkaProducerException,
} from '../common/exceptions/kafka.exception';
import { CONFIG } from '../common/constants/config.constants';
import { LoggerService } from '../common/services/logger.service';
import { CircuitBreaker } from '../common/utils/circuit-breaker';
import { IKafkaConfig } from '../common/types/kafka.types';

type KafkaProducer = Producer<string, unknown, string, string>;
type KafkaConsumer = Consumer<string, unknown, string, string>;
type KafkaStream = MessagesStream<string, unknown, string, string>;
type KafkaMessage = Message<string, unknown, string, string>;

type KafkaModule = typeof import('@platformatic/kafka');
type KafkaModuleLoader = () => Promise<KafkaModule>;

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function(
  'specifier',
  'return import(specifier);',
) as (specifier: string) => Promise<KafkaModule>;

let kafkaModulePromise: Promise<KafkaModule> | null = null;

/**
 * Loads and caches the ESM-only Platformatic Kafka module.
 *
 * @returns The installed Platformatic Kafka module.
 * @throws Propagates package resolution or module evaluation failures.
 */
const loadKafkaModule = (): Promise<KafkaModule> => {
  if (!kafkaModulePromise) {
    kafkaModulePromise = dynamicImport('@platformatic/kafka').catch((error) => {
      kafkaModulePromise = null;
      throw error;
    });
  }

  return kafkaModulePromise;
};

/** Optional Nest injection token used to replace the ESM loader in tests. */
export const KAFKA_MODULE_LOADER = Symbol('KAFKA_MODULE_LOADER');

/**
 * Prevents a detached Kafka emitter from escalating a later error event after
 * an asynchronous close has failed. The original close failure is logged.
 *
 * @returns Nothing.
 */
const ignoreDetachedKafkaError = (): void => undefined;

export enum KafkaConnectionState {
  initializing = 'initializing',
  ready = 'ready',
  reconnecting = 'reconnecting',
  failed = 'failed',
  disabled = 'disabled',
}

export interface KafkaHealthStatus {
  state: KafkaConnectionState;
  reconnectAttempts: number;
  reason?: string;
}

interface ConsumerConfig {
  topics: string[];
  onMessage: (message: unknown) => Promise<void>;
}

interface ConsumerListeners {
  error: (error: Error) => void;
  rebalance: (info: unknown) => void;
  brokerDisconnect: (details: unknown) => void;
  brokerFailed: (details: unknown) => void;
}

@Injectable()
export class KafkaService implements OnApplicationShutdown, OnModuleInit {
  private readonly logger = new LoggerService(KafkaService.name);
  private readonly circuitBreaker = new CircuitBreaker({
    failureThreshold: CONFIG.CIRCUIT_BREAKER.DEFAULT_FAILURE_THRESHOLD,
    resetTimeout: CONFIG.CIRCUIT_BREAKER.DEFAULT_RESET_TIMEOUT,
  });
  private readonly kafkaConfig: IKafkaConfig;
  private producer?: KafkaProducer;
  private producerPromise?: Promise<KafkaProducer>;
  private readonly consumers = new Map<string, KafkaConsumer>();
  private readonly consumerStreams = new Map<string, KafkaStream>();
  private readonly consumerLoops = new Map<string, Promise<void>>();
  private readonly consumerConfigs = new Map<string, ConsumerConfig>();
  private readonly consumerListeners = new Map<string, ConsumerListeners>();
  private readonly streamErrorListeners = new Map<
    string,
    (error: Error) => void
  >();
  private kafkaState: KafkaConnectionState = KafkaConnectionState.initializing;
  private kafkaFailureReason?: string;
  private reconnectAttempts = 0;
  private reconnectionTask?: Promise<void>;
  private reconnectRequested = false;
  private queuedKafkaFailureReason?: string;
  private reconnectCandidateActive = false;
  private shuttingDown = false;

  /**
   * Routes terminal producer errors through the shared recovery lifecycle.
   *
   * @param error The error emitted by the Platformatic producer.
   * @returns Nothing; reconnection is scheduled asynchronously.
   */
  private readonly producerErrorListener = (error: Error): void => {
    this.handleKafkaFailure('Kafka producer client error', error);
  };

  /**
   * Creates the Kafka lifecycle service from validated application settings.
   *
   * @param configService Nest configuration containing Kafka connection values.
   * @param kafkaModuleLoader Optional ESM module loader used by focused tests.
   * @throws {KafkaConnectionException} If Kafka timing configuration is invalid.
   */
  constructor(
    private readonly configService: ConfigService,
    @Optional()
    @Inject(KAFKA_MODULE_LOADER)
    private readonly kafkaModuleLoader: KafkaModuleLoader = loadKafkaModule,
  ) {
    try {
      const brokersValue = this.configService.get<
        string | string[] | undefined
      >('kafka.brokers');
      const kafkaBrokers = Array.isArray(brokersValue)
        ? brokersValue
        : (brokersValue
            ?.split(',')
            .map((broker) => broker.trim())
            .filter(Boolean) ?? CONFIG.KAFKA.DEFAULT_BROKERS);

      this.kafkaConfig = {
        clientId:
          this.configService.get<string>('kafka.clientId') ??
          CONFIG.KAFKA.DEFAULT_CLIENT_ID,
        brokers: kafkaBrokers,
        connectionTimeout:
          this.configService.get<number>('kafka.connectionTimeout') ??
          CONFIG.KAFKA.DEFAULT_CONNECTION_TIMEOUT,
        requestTimeout:
          this.configService.get<number>('kafka.requestTimeout') ??
          CONFIG.KAFKA.DEFAULT_REQUEST_TIMEOUT,
        brokerTimeout:
          this.configService.get<number>('kafka.brokerTimeout') ??
          CONFIG.KAFKA.DEFAULT_BROKER_TIMEOUT,
        sessionTimeout:
          this.configService.get<number>('kafka.sessionTimeout') ??
          CONFIG.KAFKA.DEFAULT_SESSION_TIMEOUT,
        heartbeatInterval:
          this.configService.get<number>('kafka.heartbeatInterval') ??
          CONFIG.KAFKA.DEFAULT_HEARTBEAT_INTERVAL,
        maxWaitTime:
          this.configService.get<number>('kafka.maxWaitTime') ??
          CONFIG.KAFKA.DEFAULT_MAX_WAIT_TIME,
        retry: {
          initialRetryTime:
            this.configService.get<number>('kafka.retry.initialRetryTime') ??
            CONFIG.KAFKA.DEFAULT_INITIAL_RETRY_TIME,
          retries:
            this.configService.get<number>('kafka.retry.retries') ??
            CONFIG.KAFKA.DEFAULT_RETRIES,
          maxRetryTime:
            this.configService.get<number>('kafka.retry.maxRetryTime') ??
            CONFIG.KAFKA.DEFAULT_MAX_RETRY_TIME,
        },
      };
      this.validateTimingOptions();
    } catch (error) {
      const err = this.normalizeError(
        error,
        'Failed to initialize Kafka service',
      );
      this.logger.error(err.message, { error: err.stack || err.message });
      this.kafkaState = KafkaConnectionState.failed;
      throw new KafkaConnectionException({
        error: err.stack || err.message,
      });
    }
  }

  async onModuleInit(): Promise<void> {
    try {
      const producer = await this.ensureProducer();
      await producer.metadata({ topics: [] });
      this.logger.info('Kafka service initialized successfully');
      this.kafkaState = KafkaConnectionState.ready;
      this.kafkaFailureReason = undefined;
    } catch (error) {
      const err = this.normalizeError(
        error,
        'Failed to initialize Kafka producer metadata request',
      );
      this.logger.error(err.message, { error: err.stack || err.message });
      this.kafkaState = KafkaConnectionState.failed;
      throw new KafkaConnectionException({
        error: err.stack || err.message,
      });
    }
  }

  async produce(topic: string, message: unknown): Promise<void> {
    const correlationId = uuidv4();
    const timestamp = Date.now();

    try {
      await this.circuitBreaker.execute(async () =>
        this.sendRecords(topic, [message], correlationId, timestamp),
      );

      this.logger.info(`[KAFKA-PRODUCER] Message produced to ${topic}`, {
        correlationId,
        topic,
        timestamp: new Date(timestamp).toISOString(),
      });
    } catch (error) {
      const err = this.normalizeError(
        error,
        `Failed to produce message to ${topic}`,
      );
      this.logger.error(err.message, {
        correlationId,
        error: err.stack || err.message,
      });
      throw new KafkaProducerException(
        `Failed to produce message to ${topic}: ${err.message}`,
      );
    }
  }

  async produceBatch(topic: string, messages: unknown[]): Promise<void> {
    const correlationId = uuidv4();
    const timestamp = Date.now();

    try {
      await this.circuitBreaker.execute(async () =>
        this.sendRecords(topic, messages, correlationId, timestamp),
      );

      this.logger.info(`[KAFKA-PRODUCER] Batch produced to ${topic}`, {
        correlationId,
        count: messages.length,
        topic,
        timestamp: new Date(timestamp).toISOString(),
      });
    } catch (error) {
      const err = this.normalizeError(
        error,
        `Failed to produce batch to ${topic}`,
      );
      this.logger.error(err.message, {
        correlationId,
        topic,
        count: messages.length,
        error: err.stack || err.message,
      });
      throw new KafkaProducerException(
        `Failed to produce batch to ${topic}: ${err.message}`,
      );
    }
  }

  async sendMessage(topic: string, message: unknown): Promise<void> {
    const correlationId = uuidv4();
    const timestamp = Date.now();

    try {
      await this.sendRecords(topic, [message], correlationId, timestamp);
      this.logger.log(`Message sent to topic ${topic}`);
    } catch (error) {
      const err = this.normalizeError(
        error,
        `Failed to send message to topic ${topic}`,
      );
      this.logger.error(err.message, {
        topic,
        error: err.stack || err.message,
      });
      throw new KafkaProducerException(
        `Failed to send message to topic ${topic}: ${err.message}`,
      );
    }
  }

  async consume(
    groupId: string,
    topics: string[],
    onMessage: (message: unknown) => Promise<void>,
  ): Promise<void> {
    this.consumerConfigs.set(groupId, { topics, onMessage });

    try {
      await this.startConsumerSession(groupId);
    } catch (error) {
      const err = this.normalizeError(
        error,
        `Failed to start consumer for group ${groupId}`,
      );
      this.logger.error(err.message, {
        groupId,
        topics,
        error: err.stack || err.message,
      });
      this.handleKafkaFailure(err.message, err);
      throw new KafkaConsumerException(
        `Failed to start consumer for group ${groupId}`,
        { error: err.stack || err.message },
      );
    }
  }

  /**
   * Starts one configured consumer-group stream.
   *
   * Existing state for the group is fully detached before a replacement client
   * is created. Reconnect attempts can defer the ready transition until every
   * configured group has restarted successfully.
   *
   * @param groupId The consumer group whose saved subscription should start.
   * @param updateHealth Whether a successful start should mark Kafka ready.
   * @returns A promise that resolves after the stream and processing loop start.
   * @throws If the Platformatic consumer cannot be created or subscribed.
   */
  private async startConsumerSession(
    groupId: string,
    updateHealth = true,
  ): Promise<void> {
    const config = this.consumerConfigs.get(groupId);

    if (!config) {
      this.logger.warn(`No consumer configuration found for group ${groupId}`);
      return;
    }

    await this.circuitBreaker.execute(async () => {
      if (
        this.consumers.has(groupId) ||
        this.consumerStreams.has(groupId) ||
        this.consumerLoops.has(groupId)
      ) {
        await this.closeConsumer(groupId);
      }

      const consumer = await this.getOrCreateConsumer(groupId);
      const stream = await consumer.consume({
        topics: config.topics,
        autocommit: false,
        mode: 'committed',
        fallbackMode: 'latest',
      });

      const streamErrorListener = (error: Error): void => {
        this.handleKafkaFailure(
          `Kafka stream error for group ${groupId}`,
          error,
        );
      };
      stream.on('error', streamErrorListener);

      this.consumerStreams.set(groupId, stream);
      this.streamErrorListeners.set(groupId, streamErrorListener);
      const loop = this.startConsumerLoop(
        groupId,
        config.topics,
        stream,
        config.onMessage,
      );
      this.consumerLoops.set(groupId, loop);

      if (updateHealth) {
        this.kafkaState = KafkaConnectionState.ready;
        this.kafkaFailureReason = undefined;
        this.reconnectAttempts = 0;
      }
    });
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info('Starting Kafka graceful shutdown', { signal });
    this.shuttingDown = true;

    try {
      if (this.reconnectionTask) {
        this.logger.info('Waiting for Kafka reconnection task to finish...');
        try {
          await this.reconnectionTask;
        } catch (error) {
          const err = this.normalizeError(
            error,
            'Kafka reconnection task failed during shutdown',
          );
          this.logger.warn(err.message, { error: err.stack || err.message });
        }
      }

      this.logger.info('Closing Kafka consumers...');
      const groupIds = new Set([
        ...this.consumers.keys(),
        ...this.consumerStreams.keys(),
        ...this.consumerLoops.keys(),
      ]);
      await Promise.all(
        Array.from(groupIds).map((groupId) => this.closeConsumer(groupId)),
      );

      this.logger.info('Closing Kafka producer...');
      await this.closeProducer();
      this.logger.info('Kafka connections closed successfully');
    } catch (error) {
      const err = this.normalizeError(error, 'Error during Kafka shutdown');
      this.logger.error(err.message, {
        signal,
        error: err.stack || err.message,
      });
      throw err;
    } finally {
      this.consumerLoops.clear();
      this.consumerStreams.clear();
      this.consumers.clear();
      this.consumerConfigs.clear();
      this.consumerListeners.clear();
      this.streamErrorListeners.clear();
      this.producer = undefined;
      this.producerPromise = undefined;
      this.kafkaState = KafkaConnectionState.disabled;
      this.kafkaFailureReason = undefined;
    }
  }

  // The asynchronous signature is retained for health-check API compatibility.
  // eslint-disable-next-line @typescript-eslint/require-await
  async isConnected(): Promise<boolean> {
    if (
      this.kafkaState === KafkaConnectionState.failed ||
      this.kafkaState === KafkaConnectionState.reconnecting ||
      this.kafkaState === KafkaConnectionState.initializing ||
      this.kafkaState === KafkaConnectionState.disabled
    ) {
      return false;
    }

    try {
      const producerConnected = this.producer?.isConnected?.() ?? false;
      const consumersConnected = Array.from(this.consumers.values()).every(
        (consumer) => consumer.isConnected(),
      );

      const connected = producerConnected && consumersConnected;

      if (!connected && !this.shuttingDown) {
        this.handleKafkaFailure(
          'Kafka connection verification failed',
          new Error('Kafka producer or consumers are disconnected'),
        );
      }

      return connected;
    } catch (error) {
      const err = this.normalizeError(
        error,
        'Failed to check Kafka connection status',
      );
      this.logger.error(err.message, {
        error: err.stack || err.message,
        timestamp: new Date().toISOString(),
      });
      this.handleKafkaFailure('Kafka connection status error', err);
      return false;
    }
  }

  getKafkaStatus(): KafkaHealthStatus {
    return {
      state: this.kafkaState,
      reconnectAttempts: this.reconnectAttempts,
      reason: this.kafkaFailureReason,
    };
  }

  private async ensureProducer(): Promise<KafkaProducer> {
    if (this.producer) {
      return this.producer;
    }

    if (!this.producerPromise) {
      this.producerPromise = this.createProducer();
    }

    try {
      this.producer = await this.producerPromise;
      return this.producer;
    } catch (error) {
      this.producerPromise = undefined;
      throw error;
    }
  }

  private async createProducer(): Promise<KafkaProducer> {
    const { Producer, ProduceAcks, jsonSerializer, stringSerializer } =
      await this.kafkaModuleLoader();

    const producer = new Producer({
      clientId: this.kafkaConfig.clientId,
      bootstrapBrokers: this.kafkaConfig.brokers,
      idempotent: true,
      acks: ProduceAcks.ALL,
      connectTimeout: this.kafkaConfig.connectionTimeout,
      requestTimeout: this.kafkaConfig.requestTimeout,
      timeout: this.kafkaConfig.brokerTimeout,
      retries: this.kafkaConfig.retry.retries,
      retryDelay: this.kafkaConfig.retry.initialRetryTime,
      maxInflights: CONFIG.KAFKA.DEFAULT_MAX_IN_FLIGHT_REQUESTS,
      serializers: {
        key: stringSerializer,
        value: jsonSerializer,
        headerKey: stringSerializer,
        headerValue: stringSerializer,
      },
    });
    producer.on('error', this.producerErrorListener);

    return producer;
  }

  /**
   * Creates the lifecycle listeners associated with one consumer group.
   *
   * @param groupId Consumer group whose client emits the events.
   * @returns Stable listeners that can be removed before client teardown.
   */
  private createConsumerListeners(groupId: string): ConsumerListeners {
    return {
      error: (error: Error): void => {
        this.handleKafkaFailure(
          `Kafka consumer client error for group ${groupId}`,
          error,
        );
      },
      rebalance: (info: unknown): void => {
        this.logger.info(`Kafka consumer ${groupId} rebalanced`, { info });
      },
      brokerDisconnect: (details: unknown): void => {
        this.logger.warn(`Kafka consumer ${groupId} disconnected from broker`, {
          details,
        });
      },
      brokerFailed: (details: unknown): void => {
        this.logger.error(`Kafka consumer ${groupId} broker failure`, {
          details,
        });
        this.handleKafkaFailure(
          `Kafka consumer ${groupId} broker failure`,
          this.normalizeError(
            details,
            `Kafka consumer ${groupId} broker failure`,
          ),
        );
      },
    };
  }

  private async getOrCreateConsumer(groupId: string): Promise<KafkaConsumer> {
    const existing = this.consumers.get(groupId);
    if (existing) {
      return existing;
    }

    const { Consumer, jsonDeserializer, stringDeserializer } =
      await this.kafkaModuleLoader();

    const consumer = new Consumer({
      clientId: `${this.kafkaConfig.clientId}-${groupId}`,
      groupId,
      bootstrapBrokers: this.kafkaConfig.brokers,
      autocommit: false,
      connectTimeout: this.kafkaConfig.connectionTimeout,
      requestTimeout: this.kafkaConfig.requestTimeout,
      timeout: this.kafkaConfig.brokerTimeout,
      sessionTimeout: this.kafkaConfig.sessionTimeout,
      heartbeatInterval: this.kafkaConfig.heartbeatInterval,
      retries: this.kafkaConfig.retry.retries,
      retryDelay: this.kafkaConfig.retry.initialRetryTime,
      maxWaitTime: this.kafkaConfig.maxWaitTime,
      maxBytes: CONFIG.KAFKA.DEFAULT_MAX_BYTES,
      deserializers: {
        key: stringDeserializer,
        value: jsonDeserializer,
        headerKey: stringDeserializer,
        headerValue: stringDeserializer,
      },
    });

    const listeners = this.createConsumerListeners(groupId);
    consumer.on('error', listeners.error);
    consumer.on('consumer:group:rebalance', listeners.rebalance);
    consumer.on('client:broker:disconnect', listeners.brokerDisconnect);
    consumer.on('client:broker:failed', listeners.brokerFailed);

    this.consumers.set(groupId, consumer);
    this.consumerListeners.set(groupId, listeners);
    return consumer;
  }

  private async startConsumerLoop(
    groupId: string,
    topics: string[],
    stream: KafkaStream,
    onMessage: (message: unknown) => Promise<void>,
  ): Promise<void> {
    try {
      for await (const message of stream) {
        const correlationId =
          this.getHeaderValue(message.headers, 'correlation-id') || uuidv4();
        const messageTimestamp = Number(
          message.timestamp ?? BigInt(Date.now()),
        );

        try {
          if (message.value === undefined) {
            throw new Error('Message value is undefined');
          }

          this.logger.info(
            `[KAFKA-CONSUMER] Starting to process message from ${message.topic}`,
            {
              correlationId,
              topic: message.topic,
              partition: message.partition,
              timestamp: new Date(messageTimestamp).toISOString(),
            },
          );

          await onMessage(message.value);

          this.logger.info(
            `[KAFKA-CONSUMER] Completed processing message from ${message.topic}`,
            {
              correlationId,
              topic: message.topic,
              partition: message.partition,
              timestamp: new Date().toISOString(),
            },
          );
        } catch (processingError) {
          const err = this.normalizeError(
            processingError,
            `Error processing message from topic ${message.topic}`,
          );
          this.logger.error(err.message, {
            correlationId,
            topic: message.topic,
            partition: message.partition,
            error: err.stack || err.message,
          });
          await this.sendToDLQ(message.topic, message.value).catch(
            (dlqError) => {
              const dlqErr = this.normalizeError(
                dlqError,
                `Failed to send message to DLQ for topic ${message.topic}`,
              );
              this.logger.error(dlqErr.message, {
                correlationId,
                topic: message.topic,
                error: dlqErr.stack || dlqErr.message,
              });
            },
          );
        }

        const committed = await this.commitMessage(groupId, message);
        if (!committed) {
          return;
        }
      }
    } catch (error) {
      if (!this.shuttingDown) {
        const err = this.normalizeError(error, 'Kafka consumer loop error');
        this.logger.error(err.message, {
          groupId,
          topics,
          error: err.stack || err.message,
        });
        this.handleKafkaFailure('Kafka consumer loop error', err);
      }
    } finally {
      if (this.consumerStreams.get(groupId) === stream) {
        const streamErrorListener = this.streamErrorListeners.get(groupId);
        if (streamErrorListener) {
          stream.removeListener('error', streamErrorListener);
        }
        this.streamErrorListeners.delete(groupId);
        this.consumerStreams.delete(groupId);
        this.consumerLoops.delete(groupId);
      }
      if (!this.shuttingDown) {
        this.logger.warn(`Kafka consumer loop for group ${groupId} ended`);
      }
    }
  }

  /**
   * Commits a processed message and routes commit failures through recovery.
   *
   * Manual commits retain progression after handler or DLQ completion while
   * making offset commit timeouts visible to health and the shared
   * multi-consumer reconnect lifecycle.
   *
   * @param groupId Consumer group that owns the message offset.
   * @param message Platformatic message whose next offset should be committed.
   * @returns True after commit success, or false after recovery starts. A false
   * result tells the caller to stop the stream before a later offset can commit
   * past the failed record.
   */
  private async commitMessage(
    groupId: string,
    message: KafkaMessage,
  ): Promise<boolean> {
    try {
      await message.commit();
      return true;
    } catch (error) {
      this.handleKafkaFailure(
        `Failed to commit Kafka message offset for group ${groupId}`,
        error,
      );
      return false;
    }
  }

  /**
   * Detaches and closes one consumer stream without leaking error events.
   *
   * @param groupId Consumer group whose active stream should close.
   * @returns True when no stream exists or close succeeds; otherwise false.
   */
  private async closeStream(groupId: string): Promise<boolean> {
    const stream = this.consumerStreams.get(groupId);
    if (!stream) {
      return true;
    }

    this.consumerStreams.delete(groupId);
    const streamErrorListener = this.streamErrorListeners.get(groupId);
    this.streamErrorListeners.delete(groupId);

    stream.on('error', ignoreDetachedKafkaError);
    if (streamErrorListener) {
      stream.removeListener('error', streamErrorListener);
    }

    try {
      await stream.close();
      stream.removeListener('error', ignoreDetachedKafkaError);
      return true;
    } catch (error) {
      const err = this.normalizeError(
        error,
        `Failed to close Kafka stream for group ${groupId}`,
      );
      this.logger.warn(err.message, {
        groupId,
        error: err.stack || err.message,
      });
      return false;
    }
  }

  private buildHeaders(
    correlationId: string,
    timestamp: number,
  ): Record<string, string> {
    return {
      'correlation-id': correlationId,
      timestamp: timestamp.toString(),
      'content-type': 'application/json',
    };
  }

  private getHeaderValue(
    headers: Map<string, string> | undefined,
    key: string,
  ): string | undefined {
    if (!headers) {
      return undefined;
    }

    const value = headers.get(key);
    if (typeof value === 'string') {
      return value;
    }

    return undefined;
  }

  private async sendRecords(
    topic: string,
    values: unknown[],
    correlationId: string,
    timestamp: number,
  ): Promise<void> {
    const producer = await this.ensureProducer();
    const { ProduceAcks } = await this.kafkaModuleLoader();
    const headers = this.buildHeaders(correlationId, timestamp);

    await producer.send({
      messages: values.map((value) => ({
        topic,
        value,
        headers,
      })),
      acks: ProduceAcks.ALL,
    });
  }

  private async sendToDLQ(
    originalTopic: string,
    message: unknown,
  ): Promise<void> {
    const dlqTopic = `${originalTopic}.dlq`;

    const serializedMessage = this.serializeForDlq(message);

    await this.produce(dlqTopic, {
      originalTopic,
      originalMessage: serializedMessage,
      error: 'Failed to process message',
      timestamp: new Date().toISOString(),
    });
  }

  private serializeForDlq(message: unknown): string {
    try {
      if (Buffer.isBuffer(message)) {
        return message.toString('base64');
      }

      if (message === undefined) {
        return Buffer.from('null', 'utf8').toString('base64');
      }

      return Buffer.from(JSON.stringify(message), 'utf8').toString('base64');
    } catch (error) {
      const fallback = this.normalizeError(
        error,
        'Failed to serialize DLQ message',
      );
      this.logger.warn(fallback.message, {
        error: fallback.stack || fallback.message,
      });
      return Buffer.from(String(message), 'utf8').toString('base64');
    }
  }

  private handleKafkaFailure(context: string, error: unknown): void {
    if (this.shuttingDown) {
      return;
    }

    const queueAfterCurrentReconnect =
      this.reconnectionTask !== undefined &&
      (this.reconnectCandidateActive ||
        this.kafkaState === KafkaConnectionState.ready);
    const err =
      error instanceof Error
        ? error
        : this.normalizeError(error, context || 'Kafka failure');
    const trace = err.stack || err.message;

    this.logger.error(context, {
      error: trace,
      timestamp: new Date().toISOString(),
    });

    this.kafkaFailureReason = trace;

    if (this.kafkaState !== KafkaConnectionState.reconnecting) {
      this.kafkaState = KafkaConnectionState.reconnecting;
    }

    void this.scheduleReconnect(queueAfterCurrentReconnect);
  }

  /**
   * Starts or reuses the shared Kafka reconnect task.
   *
   * A terminal error from replacement clients is queued while the active task
   * settles so it cannot be overwritten by a premature ready transition.
   *
   * @param queueAfterCurrentReconnect Whether another rebuild is required once
   * the active reconnect task settles.
   * @returns The active reconnect task, or an already-resolved task at shutdown.
   */
  private scheduleReconnect(queueAfterCurrentReconnect = false): Promise<void> {
    if (this.shuttingDown) {
      return Promise.resolve();
    }

    if (this.reconnectionTask) {
      if (queueAfterCurrentReconnect) {
        this.reconnectRequested = true;
        this.queuedKafkaFailureReason = this.kafkaFailureReason;
      }

      return this.reconnectionTask;
    }

    this.reconnectionTask = this.performReconnect().finally(() => {
      this.reconnectionTask = undefined;

      const reconnectRequested = this.reconnectRequested;
      const queuedFailureReason = this.queuedKafkaFailureReason;
      this.reconnectRequested = false;
      this.queuedKafkaFailureReason = undefined;

      if (reconnectRequested && !this.shuttingDown) {
        this.kafkaState = KafkaConnectionState.reconnecting;
        this.kafkaFailureReason = queuedFailureReason;
        void this.scheduleReconnect();
      }
    });

    return this.reconnectionTask;
  }

  private async performReconnect(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    const maxAttempts = Math.max(this.kafkaConfig.retry.retries, 1);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.shuttingDown) {
        return;
      }

      this.reconnectAttempts = attempt;
      await this.wait(this.getReconnectDelay(attempt));

      if (this.shuttingDown) {
        return;
      }

      try {
        await this.restartKafkaClients(true);
        this.reconnectCandidateActive = false;

        if (this.reconnectRequested) {
          const failureReason =
            this.queuedKafkaFailureReason ??
            'Replacement Kafka client failed during startup';
          this.reconnectRequested = false;
          this.queuedKafkaFailureReason = undefined;
          throw new Error(failureReason);
        }

        this.kafkaState = KafkaConnectionState.ready;
        this.kafkaFailureReason = undefined;
        this.reconnectAttempts = 0;

        this.logger.info('Kafka clients reconnected successfully', {
          attempt,
          timestamp: new Date().toISOString(),
        });

        return;
      } catch (error) {
        this.reconnectCandidateActive = false;
        this.reconnectRequested = false;
        this.queuedKafkaFailureReason = undefined;

        const err = this.normalizeError(
          error,
          'Kafka reconnection attempt failed',
        );
        this.kafkaFailureReason = err.stack || err.message;
        this.logger.error(err.message, {
          attempt,
          maxAttempts,
          error: err.stack || err.message,
        });
      }
    }

    if (!this.shuttingDown) {
      this.kafkaState = KafkaConnectionState.failed;
      this.logger.error('Kafka reconnection attempts exhausted', {
        reason: this.kafkaFailureReason,
        attempts: this.reconnectAttempts,
      });
    }
  }

  /**
   * Rebuilds the shared producer and every configured consumer group.
   *
   * @param trackReplacementFailures Whether failures from newly created clients
   * should queue another reconnect after the active attempt.
   * @returns A promise that resolves once all replacement clients and streams
   * are ready.
   * @throws If a replacement producer or consumer cannot be initialized.
   */
  private async restartKafkaClients(
    trackReplacementFailures = false,
  ): Promise<void> {
    const groupIds = Array.from(this.consumerConfigs.keys());

    await Promise.all(groupIds.map((groupId) => this.closeConsumer(groupId)));
    await this.closeProducer();

    if (this.shuttingDown) {
      return;
    }

    if (trackReplacementFailures) {
      this.reconnectCandidateActive = true;
    }

    const producer = await this.ensureProducer();
    await producer.metadata({ topics: [] });

    for (const groupId of groupIds) {
      await this.startConsumerSession(groupId, false);
    }
  }

  /**
   * Detaches and closes one consumer, its stream, and its processing loop.
   *
   * The maps are cleared before asynchronous close operations so a replacement
   * session cannot be deleted by the old loop's finalizer. A successfully
   * closed stream is drained through its processing loop before the underlying
   * consumer closes, allowing an in-flight manual commit to finish. Close
   * failures are logged and detached emitters retain a no-op error listener.
   *
   * @param groupId Consumer group whose resources should be released.
   * @returns A promise that resolves after all safely waitable resources settle.
   */
  private async closeConsumer(groupId: string): Promise<void> {
    const loop = this.consumerLoops.get(groupId);
    this.consumerLoops.delete(groupId);
    const streamClosed = await this.closeStream(groupId);

    const consumer = this.consumers.get(groupId);
    this.consumers.delete(groupId);
    const listeners = this.consumerListeners.get(groupId);
    this.consumerListeners.delete(groupId);
    if (consumer) {
      consumer.on('error', ignoreDetachedKafkaError);
      if (listeners) {
        consumer.removeListener('error', listeners.error);
        consumer.removeListener(
          'consumer:group:rebalance',
          listeners.rebalance,
        );
        consumer.removeListener(
          'client:broker:disconnect',
          listeners.brokerDisconnect,
        );
        consumer.removeListener('client:broker:failed', listeners.brokerFailed);
      }
    }

    if (loop && streamClosed) {
      try {
        await loop;
      } catch (error) {
        const err = this.normalizeError(
          error,
          `Kafka consumer loop rejected for group ${groupId}`,
        );
        this.logger.warn(err.message, { error: err.stack || err.message });
      }
    }

    let consumerClosed = consumer === undefined;
    if (consumer) {
      try {
        await Promise.resolve(consumer.close(true));
        consumerClosed = true;
        consumer.removeListener('error', ignoreDetachedKafkaError);
        this.logger.info(`Consumer ${groupId} closed successfully`);
      } catch (error) {
        const err = this.normalizeError(
          error,
          `Failed to close Kafka consumer ${groupId}`,
        );
        this.logger.warn(err.message, {
          groupId,
          error: err.stack || err.message,
        });
      }
    }

    if (loop && !streamClosed && consumerClosed) {
      try {
        await loop;
      } catch (error) {
        const err = this.normalizeError(
          error,
          `Kafka consumer loop rejected for group ${groupId}`,
        );
        this.logger.warn(err.message, { error: err.stack || err.message });
      }
    } else if (loop && !streamClosed) {
      void loop.catch((error) => {
        const err = this.normalizeError(
          error,
          `Detached Kafka consumer loop rejected for group ${groupId}`,
        );
        this.logger.warn(err.message, { error: err.stack || err.message });
      });
    }
  }

  /**
   * Detaches and closes the shared Kafka producer.
   *
   * @returns A promise that resolves after close succeeds or a failure is
   * logged. It does not throw so consumer cleanup can continue.
   */
  private async closeProducer(): Promise<void> {
    let producer = this.producer;
    const producerPromise = this.producerPromise;
    this.producer = undefined;
    this.producerPromise = undefined;

    if (!producer && producerPromise) {
      try {
        producer = await producerPromise;
      } catch (error) {
        const err = this.normalizeError(
          error,
          'Kafka producer failed before it could be closed',
        );
        this.logger.warn(err.message, { error: err.stack || err.message });
        return;
      }
    }

    if (!producer) {
      return;
    }

    producer.on('error', ignoreDetachedKafkaError);
    producer.removeListener('error', this.producerErrorListener);

    try {
      await Promise.resolve(producer.close(true));
      producer.removeListener('error', ignoreDetachedKafkaError);
    } catch (error) {
      const err = this.normalizeError(error, 'Failed to close Kafka producer');
      this.logger.warn(err.message, { error: err.stack || err.message });
    }
  }

  private async wait(delayMs: number): Promise<void> {
    if (delayMs <= 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private getRetryDelay(attempt: number): number {
    const baseDelay = this.kafkaConfig.retry.initialRetryTime;
    const maxDelay = this.kafkaConfig.retry.maxRetryTime;
    const exponent = Math.max(attempt - 1, 0);
    const calculatedDelay = baseDelay * Math.pow(2, exponent);

    return Math.min(calculatedDelay, maxDelay);
  }

  /**
   * Calculates equal-jitter backoff for a reconnection attempt.
   *
   * @param attempt One-based reconnection attempt number.
   * @returns A delay between half and all of the bounded exponential backoff.
   */
  private getReconnectDelay(attempt: number): number {
    const retryDelay = this.getRetryDelay(attempt);
    const minimumDelay = Math.floor(retryDelay / 2);
    const jitterRange = retryDelay - minimumDelay;

    return minimumDelay + Math.floor(Math.random() * (jitterRange + 1));
  }

  /**
   * Validates independently configured Kafka transport and group timeouts.
   *
   * The request deadline must outlive broker and Fetch waits, while the group
   * session must leave enough time for a heartbeat request to time out before
   * Kafka evicts the consumer.
   *
   * @returns Nothing when every timing value and relationship is valid.
   * @throws {Error} If a value is not a positive integer or related timeouts
   * would race one another.
   */
  private validateTimingOptions(): void {
    const timingOptions = [
      ['connectionTimeout', this.kafkaConfig.connectionTimeout],
      ['requestTimeout', this.kafkaConfig.requestTimeout],
      ['brokerTimeout', this.kafkaConfig.brokerTimeout],
      ['sessionTimeout', this.kafkaConfig.sessionTimeout],
      ['heartbeatInterval', this.kafkaConfig.heartbeatInterval],
      ['maxWaitTime', this.kafkaConfig.maxWaitTime],
    ] as const;

    for (const [name, value] of timingOptions) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Kafka ${name} must be a positive integer`);
      }
    }

    if (this.kafkaConfig.maxWaitTime >= this.kafkaConfig.requestTimeout) {
      throw new Error('Kafka maxWaitTime must be less than requestTimeout');
    }

    if (this.kafkaConfig.brokerTimeout >= this.kafkaConfig.requestTimeout) {
      throw new Error('Kafka brokerTimeout must be less than requestTimeout');
    }

    if (
      this.kafkaConfig.heartbeatInterval + this.kafkaConfig.requestTimeout >=
      this.kafkaConfig.sessionTimeout
    ) {
      throw new Error(
        'Kafka heartbeatInterval plus requestTimeout must be less than sessionTimeout',
      );
    }
  }

  private normalizeError(error: unknown, fallbackMessage: string): Error {
    if (error instanceof Error) {
      return error;
    }

    if (typeof error === 'string') {
      return new Error(`${fallbackMessage}: ${error}`);
    }

    try {
      return new Error(`${fallbackMessage}: ${JSON.stringify(error)}`);
    } catch (serializationError) {
      const serializationMessage =
        serializationError instanceof Error
          ? serializationError.message
          : 'unknown serialization error';
      return new Error(
        `${fallbackMessage}; failed to serialize original error: ${serializationMessage}`,
      );
    }
  }
}
