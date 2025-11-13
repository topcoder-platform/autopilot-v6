import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Consumer,
  MessagesStream,
  ProduceAcks,
  Producer,
  jsonDeserializer,
  jsonSerializer,
  stringDeserializer,
  stringSerializer,
} from '@platformatic/kafka';
import { v4 as uuidv4 } from 'uuid';

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

@Injectable()
export class KafkaService implements OnApplicationShutdown, OnModuleInit {
  private readonly logger = new LoggerService(KafkaService.name);
  private readonly circuitBreaker = new CircuitBreaker({
    failureThreshold: CONFIG.CIRCUIT_BREAKER.DEFAULT_FAILURE_THRESHOLD,
    resetTimeout: CONFIG.CIRCUIT_BREAKER.DEFAULT_RESET_TIMEOUT,
  });
  private readonly kafkaConfig: IKafkaConfig;
  private producer: KafkaProducer;
  private readonly consumers = new Map<string, KafkaConsumer>();
  private readonly consumerStreams = new Map<string, KafkaStream>();
  private readonly consumerLoops = new Map<string, Promise<void>>();
  private readonly consumerConfigs = new Map<string, ConsumerConfig>();
  private kafkaState: KafkaConnectionState = KafkaConnectionState.initializing;
  private kafkaFailureReason?: string;
  private reconnectAttempts = 0;
  private reconnectionTask?: Promise<void>;
  private shuttingDown = false;

  constructor(private readonly configService: ConfigService) {
    try {
      const brokersValue = this.configService.get<
        string | string[] | undefined
      >('kafka.brokers');
      const kafkaBrokers = Array.isArray(brokersValue)
        ? brokersValue
        : brokersValue?.split(',') || CONFIG.KAFKA.DEFAULT_BROKERS;

      this.kafkaConfig = {
        clientId:
          this.configService.get('kafka.clientId') ||
          CONFIG.KAFKA.DEFAULT_CLIENT_ID,
        brokers: kafkaBrokers,
        retry: {
          initialRetryTime:
            this.configService.get('kafka.retry.initialRetryTime') ||
            CONFIG.KAFKA.DEFAULT_INITIAL_RETRY_TIME,
          retries:
            this.configService.get('kafka.retry.retries') ||
            CONFIG.KAFKA.DEFAULT_RETRIES,
          maxRetryTime:
            this.configService.get('kafka.retry.maxRetryTime') ||
            CONFIG.KAFKA.DEFAULT_MAX_RETRY_TIME,
        },
      };

      this.producer = this.createProducer();
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
      await this.producer.metadata({ topics: [] });
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

  private async startConsumerSession(groupId: string): Promise<void> {
    const config = this.consumerConfigs.get(groupId);

    if (!config) {
      this.logger.warn(`No consumer configuration found for group ${groupId}`);
      return;
    }

    await this.circuitBreaker.execute(async () => {
      const consumer = this.getOrCreateConsumer(groupId);

      if (this.consumerStreams.has(groupId)) {
        await this.closeStream(groupId);
      }

      const stream = await consumer.consume({
        topics: config.topics,
        autocommit: true,
      });

      stream.on('error', (error) => {
        this.handleKafkaFailure(
          `Kafka stream error for group ${groupId}`,
          error,
        );
      });

      this.consumerStreams.set(groupId, stream);
      const loop = this.startConsumerLoop(
        groupId,
        config.topics,
        stream,
        config.onMessage,
      );
      this.consumerLoops.set(groupId, loop);

      this.kafkaState = KafkaConnectionState.ready;
      this.kafkaFailureReason = undefined;
      this.reconnectAttempts = 0;
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

      this.logger.info('Closing consumer streams...');
      await Promise.all(
        Array.from(this.consumerStreams.keys()).map((groupId) =>
          this.closeStream(groupId).catch((error) => {
            const err = this.normalizeError(
              error,
              `Failed closing stream for consumer ${groupId}`,
            );
            this.logger.warn(err.message, {
              groupId,
              error: err.stack || err.message,
            });
          }),
        ),
      );

      this.logger.info('Waiting for consumer loops to finish...');
      await Promise.allSettled(this.consumerLoops.values());

      this.logger.info('Closing Kafka consumers...');
      await Promise.all(
        Array.from(this.consumers.entries()).map(
          async ([groupId, consumer]) => {
            try {
              await consumer.close();
              this.logger.info(`Consumer ${groupId} closed successfully`);
            } catch (error) {
              const err = this.normalizeError(
                error,
                `Error closing consumer ${groupId}`,
              );
              this.logger.error(err.message, {
                groupId,
                error: err.stack || err.message,
              });
            }
          },
        ),
      );

      this.logger.info('Closing Kafka producer...');
      await this.producer.close();
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
      this.kafkaState = KafkaConnectionState.disabled;
      this.kafkaFailureReason = undefined;
    }
  }

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

  private createProducer(): KafkaProducer {
    return new Producer({
      clientId: this.kafkaConfig.clientId,
      bootstrapBrokers: this.kafkaConfig.brokers,
      idempotent: true,
      acks: ProduceAcks.ALL,
      retries: this.kafkaConfig.retry.retries,
      retryDelay: this.kafkaConfig.retry.initialRetryTime,
      timeout: this.kafkaConfig.retry.maxRetryTime,
      maxInflights: CONFIG.KAFKA.DEFAULT_MAX_IN_FLIGHT_REQUESTS,
      serializers: {
        key: stringSerializer,
        value: jsonSerializer,
        headerKey: stringSerializer,
        headerValue: stringSerializer,
      },
    });
  }

  private getOrCreateConsumer(groupId: string): KafkaConsumer {
    const existing = this.consumers.get(groupId);
    if (existing) {
      return existing;
    }

    const consumer = new Consumer({
      clientId: `${this.kafkaConfig.clientId}-${groupId}`,
      groupId,
      bootstrapBrokers: this.kafkaConfig.brokers,
      autocommit: true,
      retries: this.kafkaConfig.retry.retries,
      retryDelay: this.kafkaConfig.retry.initialRetryTime,
      timeout: this.kafkaConfig.retry.maxRetryTime,
      maxWaitTime: CONFIG.KAFKA.DEFAULT_MAX_WAIT_TIME,
      maxBytes: CONFIG.KAFKA.DEFAULT_MAX_BYTES,
      deserializers: {
        key: stringDeserializer,
        value: jsonDeserializer,
        headerKey: stringDeserializer,
        headerValue: stringDeserializer,
      },
    });

    consumer.on('consumer:group:rebalance', (info) => {
      this.logger.info(`Kafka consumer ${groupId} rebalanced`, { info });
    });

    consumer.on('client:broker:disconnect', (details) => {
      this.logger.warn(`Kafka consumer ${groupId} disconnected from broker`, {
        details,
      });
    });

    consumer.on('client:broker:failed', (details) => {
      this.logger.error(`Kafka consumer ${groupId} broker failure`, {
        details,
      });
      const normalized = this.normalizeError(
        details,
        `Kafka consumer ${groupId} broker failure`,
      );
      this.handleKafkaFailure(
        `Kafka consumer ${groupId} broker failure`,
        normalized,
      );
    });

    this.consumers.set(groupId, consumer);
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
      this.consumerStreams.delete(groupId);
      this.consumerLoops.delete(groupId);
      if (!this.shuttingDown) {
        this.logger.warn(`Kafka consumer loop for group ${groupId} ended`);
      }
    }
  }

  private async closeStream(groupId: string): Promise<void> {
    const stream = this.consumerStreams.get(groupId);
    if (!stream) {
      return;
    }

    await stream.close();
    this.consumerStreams.delete(groupId);
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
    const headers = this.buildHeaders(correlationId, timestamp);

    await this.producer.send({
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

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectionTask || this.shuttingDown) {
      return;
    }

    this.reconnectionTask = this.performReconnect().finally(() => {
      this.reconnectionTask = undefined;
    });
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

      try {
        await this.restartConsumers();

        this.kafkaState = KafkaConnectionState.ready;
        this.kafkaFailureReason = undefined;
        this.reconnectAttempts = 0;

        this.logger.info('Kafka consumers reconnected successfully', {
          attempt,
          timestamp: new Date().toISOString(),
        });

        return;
      } catch (error) {
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

        if (attempt < maxAttempts && !this.shuttingDown) {
          await this.wait(this.getRetryDelay(attempt));
        }
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

  private async restartConsumers(): Promise<void> {
    const groupIds = Array.from(this.consumerConfigs.keys());

    if (groupIds.length === 0) {
      return;
    }

    await Promise.all(groupIds.map((groupId) => this.closeConsumer(groupId)));

    for (const groupId of groupIds) {
      await this.startConsumerSession(groupId);
    }
  }

  private async closeConsumer(groupId: string): Promise<void> {
    await this.closeStream(groupId).catch((error) => {
      const err = this.normalizeError(
        error,
        `Failed to close Kafka stream for group ${groupId}`,
      );
      this.logger.warn(err.message, { error: err.stack || err.message });
    });

    const loop = this.consumerLoops.get(groupId);
    if (loop) {
      try {
        await loop;
      } catch (error) {
        const err = this.normalizeError(
          error,
          `Kafka consumer loop rejected for group ${groupId}`,
        );
        this.logger.warn(err.message, { error: err.stack || err.message });
      } finally {
        this.consumerLoops.delete(groupId);
      }
    }

    const consumer = this.consumers.get(groupId);
    if (consumer) {
      try {
        await consumer.close();
      } catch (error) {
        const err = this.normalizeError(
          error,
          `Failed to close Kafka consumer ${groupId}`,
        );
        this.logger.warn(err.message, { error: err.stack || err.message });
      } finally {
        this.consumers.delete(groupId);
      }
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
