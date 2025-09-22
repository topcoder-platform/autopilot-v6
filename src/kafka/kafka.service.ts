import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Kafka from 'node-rdkafka';
import {
  KafkaConnectionException,
  KafkaProducerException,
  KafkaConsumerException,
} from '../common/exceptions/kafka.exception';
import { LoggerService } from '../common/services/logger.service';
import { CircuitBreaker } from '../common/utils/circuit-breaker';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '../common/constants/config.constants';
import { IKafkaConfig } from '../common/types/kafka.types';

@Injectable()
export class KafkaService implements OnApplicationShutdown, OnModuleInit {
  private readonly producer: Kafka.Producer;
  private readonly consumers: Map<string, Kafka.KafkaConsumer>;
  private readonly consumerLoops: Map<string, boolean>;
  private readonly logger: LoggerService;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly retryDelayAfterReconnectMs = 5000;
  private readonly kafkaConfig: IKafkaConfig;
  private producerReady = false;
  private producerConnecting?: Promise<void>;

  constructor(private readonly configService: ConfigService) {
    this.logger = new LoggerService(KafkaService.name);

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

      const producerConfig: Kafka.ProducerGlobalConfig = {
        'client.id': this.kafkaConfig.clientId,
        'metadata.broker.list': this.kafkaConfig.brokers.join(','),
        dr_cb: true,
        'enable.idempotence': true,
      };

      const producerTopicConfig: Kafka.ProducerTopicConfig = {
        'request.required.acks': -1,
      };

      this.producer = new Kafka.Producer(producerConfig, producerTopicConfig);
      this.registerProducerEvents();

      this.consumers = new Map();
      this.consumerLoops = new Map();
      this.circuitBreaker = new CircuitBreaker({
        failureThreshold: CONFIG.CIRCUIT_BREAKER.DEFAULT_FAILURE_THRESHOLD,
        resetTimeout: CONFIG.CIRCUIT_BREAKER.DEFAULT_RESET_TIMEOUT,
      });
    } catch (error) {
      const err = error as Error;
      this.logger.error('Failed to initialize Kafka service', {
        error: err.stack || err.message,
      });
      throw new KafkaConnectionException({
        error: err.stack || err.message,
      });
    }
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureProducerConnected();
      this.logger.info('Kafka service initialized successfully');
    } catch (error) {
      const err = error as Error;
      this.logger.error('Failed to initialize Kafka service', {
        error: err.stack || err.message,
      });
      throw new KafkaConnectionException({
        error: err.stack || err.message,
      });
    }
  }

  private registerProducerEvents(): void {
    this.producer.on('event.error', (err: Kafka.LibrdKafkaError) => {
      this.logger.error('Kafka producer error event received', {
        error: err.message,
        code: err.code,
      });
    });

    this.producer.on('ready', () => {
      this.logger.info('Kafka producer connected');
    });

    this.producer.on('disconnected', () => {
      this.producerReady = false;
      this.producerConnecting = undefined;
      this.logger.warn('Kafka producer disconnected');
    });
  }

  private async ensureProducerConnected(): Promise<void> {
    if (this.producerReady && this.producer.isConnected()) {
      return;
    }

    if (!this.producerConnecting) {
      this.producerConnecting = new Promise((resolve, reject) => {
        const cleanup = () => {
          this.producer.removeListener('event.error', errorListener);
        };

        const errorListener = (err: Kafka.LibrdKafkaError) => {
          cleanup();
          this.producerConnecting = undefined;
          reject(new Error(err.message));
        };

        this.producer.once('event.error', errorListener);

        try {
          this.producer.connect(undefined, (err) => {
            if (err) {
              cleanup();
              this.producerConnecting = undefined;
              reject(
                this.normalizeError(
                  err,
                  'Kafka producer connection callback error',
                ),
              );
            } else {
              this.producerReady = true;
              this.producer.setPollInterval(100);
              cleanup();
              this.producerConnecting = undefined;
              resolve();
            }
          });
        } catch (connectError) {
          cleanup();
          this.producerConnecting = undefined;
          reject(connectError as Error);
        }
      });
    }

    await this.producerConnecting;

    if (!this.producerReady) {
      throw new Error('Kafka producer not ready after connection attempt');
    }
  }

  private async reconnectProducer(): Promise<void> {
    this.producerReady = false;
    this.producerConnecting = undefined;

    if (this.producer.isConnected()) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.producer.disconnect((err) => {
            if (err) {
              reject(
                this.normalizeError(err, 'Kafka producer disconnect error'),
              );
            } else {
              resolve();
            }
          });
        });
      } catch (error) {
        const err = error as Error;
        this.logger.warn('Failed to disconnect producer during reconnect', {
          error: err.stack || err.message,
        });
      }
    }

    await this.ensureProducerConnected();
  }

  private async flushProducer(timeoutMs = 1000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.producer.flush(timeoutMs, (err) => {
        if (err) {
          reject(this.normalizeError(err, 'Kafka producer flush error'));
        } else {
          resolve();
        }
      });
    });
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
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

  private async sendWithReconnect(
    sendAction: () => void,
    metadata: { topic: string; correlationId?: string; messageCount?: number },
  ): Promise<void> {
    await this.ensureProducerConnected();

    try {
      sendAction();
      await this.flushProducer();
      return;
    } catch (error) {
      const err = error as Error;
      this.logger.warn('Kafka producer send failed, attempting reconnect', {
        ...metadata,
        error: err.stack || err.message,
      });
    }

    await this.reconnectProducer();

    this.logger.info('Retrying Kafka send after reconnect delay', {
      ...metadata,
      delayMs: this.retryDelayAfterReconnectMs,
    });

    await this.delay(this.retryDelayAfterReconnectMs);

    try {
      sendAction();
      await this.flushProducer();
    } catch (retryError) {
      const retryErr = retryError as Error;
      this.logger.error('Kafka producer retry failed after reconnect', {
        ...metadata,
        error: retryErr.stack || retryErr.message,
      });
      throw retryErr;
    }
  }

  private buildHeaders(
    correlationId: string,
    timestamp: number,
  ): Array<{ key: string; value: Buffer }> {
    return [
      { key: 'correlation-id', value: Buffer.from(correlationId, 'utf8') },
      { key: 'timestamp', value: Buffer.from(timestamp.toString(), 'utf8') },
      { key: 'content-type', value: Buffer.from('application/json', 'utf8') },
    ];
  }

  private getHeaderValue(headers: unknown, key: string): string | undefined {
    if (!Array.isArray(headers)) {
      return undefined;
    }

    for (const header of headers as Array<{
      key?: unknown;
      value?: unknown;
    }>) {
      if (header?.key !== key) {
        continue;
      }

      const value = header.value;
      if (typeof value === 'string') {
        return value;
      }

      if (Buffer.isBuffer(value)) {
        return value.toString('utf8');
      }
    }

    return undefined;
  }

  async sendMessage(topic: string, message: unknown): Promise<void> {
    try {
      const encodedMessage = this.encodeMessage(message);
      await this.sendWithReconnect(
        () => {
          this.producer.produce(
            topic,
            null,
            encodedMessage,
            undefined,
            Date.now(),
          );
        },
        { topic },
      );
      this.logger.log(`Message sent to topic ${topic}`);
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Failed to send message to topic ${topic}: ${err.message}`,
      );
      throw new KafkaProducerException(
        `Failed to send message to topic ${topic}: ${err.message}`,
      );
    }
  }

  private encodeMessage(message: unknown): Buffer {
    try {
      const jsonString = JSON.stringify(message);
      return Buffer.from(jsonString, 'utf8');
    } catch (error) {
      const err = error as Error;
      this.logger.error('Failed to encode message as JSON', {
        error: err.stack || err.message,
      });
      throw new Error(`Failed to encode message as JSON: ${err.message}`);
    }
  }

  private decodeMessage(buffer: Buffer): unknown {
    try {
      const jsonString = buffer.toString('utf8');
      return JSON.parse(jsonString);
    } catch (error) {
      const err = error as Error;
      this.logger.error('Failed to decode JSON message', {
        error: err.stack || err.message,
      });
      throw new Error(`Failed to decode JSON message: ${err.message}`);
    }
  }

  async produce(topic: string, message: unknown): Promise<void> {
    const correlationId = uuidv4();
    const timestamp = Date.now();

    try {
      await this.circuitBreaker.execute(async () => {
        const encodedValue = this.encodeMessage(message);
        const headers = this.buildHeaders(correlationId, timestamp);

        await this.sendWithReconnect(
          () => {
            this.producer.produce(
              topic,
              null,
              encodedValue,
              undefined,
              timestamp,
              headers as any,
            );
          },
          { topic, correlationId },
        );

        this.logger.info(`[KAFKA-PRODUCER] Message produced to ${topic}`, {
          correlationId,
          topic,
          timestamp: new Date(timestamp).toISOString(),
        });
      });
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to produce message to ${topic}`, {
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
    const startTime = Date.now();

    try {
      await this.circuitBreaker.execute(async () => {
        this.logger.info(`Producing batch to ${topic}`, {
          correlationId,
          count: messages.length,
        });

        const timestamp = Date.now();
        const headers = this.buildHeaders(correlationId, timestamp);

        await this.sendWithReconnect(
          () => {
            messages.forEach((message) => {
              const encoded = this.encodeMessage(message);

              this.producer.produce(
                topic,
                null,
                encoded,
                undefined,
                timestamp,
                headers as any,
              );
            });
          },
          {
            topic,
            correlationId,
            messageCount: messages.length,
          },
        );
        this.logger.info(`Batch produced to ${topic}`, {
          correlationId,
          count: messages.length,
          latency: Date.now() - startTime,
        });
      });
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to produce batch to ${topic}`, {
        correlationId,
        error: err.stack || err.message,
        count: messages.length,
      });
      throw new KafkaProducerException(
        `Failed to produce batch to ${topic}: ${err.message}`,
      );
    }
  }

  async consume(
    groupId: string,
    topics: string[],
    onMessage: (message: unknown) => Promise<void>,
  ): Promise<void> {
    const correlationId = uuidv4();

    try {
      await this.circuitBreaker.execute(async () => {
        let consumer = this.consumers.get(groupId);
        if (!consumer) {
          consumer = this.createConsumer(groupId);
          this.consumers.set(groupId, consumer);
        }

        await this.connectConsumer(consumer, groupId, topics);
        this.startConsumerLoop(consumer, groupId, topics, onMessage);
      });
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to start consumer for group ${groupId}`, {
        error: err.stack,
        correlationId,
        topics,
      });
      throw new KafkaConsumerException(
        `Failed to start consumer for group ${groupId}`,
        {
          error: err.stack || err.message,
        },
      );
    }
  }

  private createConsumer(groupId: string): Kafka.KafkaConsumer {
    const consumerConfig: Kafka.ConsumerGlobalConfig = {
      'group.id': groupId,
      'metadata.broker.list': this.kafkaConfig.brokers.join(','),
      'client.id': `${this.kafkaConfig.clientId}-${groupId}`,
      'enable.auto.commit': true,
      'auto.commit.interval.ms': CONFIG.KAFKA.DEFAULT_AUTO_COMMIT_INTERVAL,
      'queued.min.messages': 1,
    };

    const topicConfig: Kafka.ConsumerTopicConfig = {
      'auto.offset.reset': 'latest',
    };

    const consumer = new Kafka.KafkaConsumer(consumerConfig, topicConfig);

    consumer.on('event.error', (err: Kafka.LibrdKafkaError) => {
      this.logger.error(`Kafka consumer error for group ${groupId}`, {
        error: err.message,
        code: err.code,
      });
    });

    consumer.on('disconnected', () => {
      this.consumerLoops.delete(groupId);
      this.logger.warn(`Kafka consumer ${groupId} disconnected`);
    });

    return consumer;
  }

  private async connectConsumer(
    consumer: Kafka.KafkaConsumer,
    groupId: string,
    topics: string[],
  ): Promise<void> {
    if (consumer.isConnected()) {
      consumer.unsubscribe();
      consumer.subscribe(topics);
      this.logger.info(`Kafka consumer ${groupId} re-subscribed`, { topics });
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        try {
          consumer.subscribe(topics);
          this.logger.info(`Kafka consumer ${groupId} connected`, { topics });
          resolve();
        } catch (subscribeError) {
          reject(subscribeError as Error);
        } finally {
          cleanup();
        }
      };

      const onError = (err: Kafka.LibrdKafkaError) => {
        cleanup();
        reject(new Error(err.message));
      };

      const cleanup = () => {
        consumer.removeListener('ready', onReady);
        consumer.removeListener('event.error', onError);
      };

      consumer.once('ready', onReady);
      consumer.once('event.error', onError);

      try {
        consumer.connect();
      } catch (error) {
        cleanup();
        reject(error as Error);
      }
    });
  }

  private startConsumerLoop(
    consumer: Kafka.KafkaConsumer,
    groupId: string,
    topics: string[],
    onMessage: (message: unknown) => Promise<void>,
  ): void {
    if (this.consumerLoops.get(groupId)) {
      return;
    }

    this.consumerLoops.set(groupId, true);

    const consumeNext = () => {
      if (!consumer.isConnected()) {
        this.logger.warn(
          `Kafka consumer ${groupId} is not connected, retrying consume`,
          {
            groupId,
            topics,
          },
        );
        setTimeout(consumeNext, this.retryDelayAfterReconnectMs);
        return;
      }

      consumer.consume(1, (err, messages) => {
        if (err) {
          this.logger.error(`Kafka consumer error for group ${groupId}`, {
            error: err.message,
            code: err.code,
          });
          setTimeout(consumeNext, this.retryDelayAfterReconnectMs);
          return;
        }

        if (!messages || messages.length === 0) {
          setTimeout(consumeNext, 100);
          return;
        }

        const [message] = messages;

        void (async () => {
          const messageCorrelationId =
            this.getHeaderValue(message.headers, 'correlation-id') || uuidv4();

          try {
            if (!message.value) {
              throw new Error('Message value is null or undefined');
            }

            const decodedMessage = this.decodeMessage(message.value);

            if (!decodedMessage) {
              throw new Error('Decoded message is null or undefined');
            }

            this.logger.info(
              `[KAFKA-CONSUMER] Starting to process message from ${message.topic}`,
              {
                correlationId: messageCorrelationId,
                topic: message.topic,
                partition: message.partition,
                timestamp: new Date().toISOString(),
              },
            );

            await onMessage(decodedMessage);

            this.logger.info(
              `[KAFKA-CONSUMER] Completed processing message from ${message.topic}`,
              {
                correlationId: messageCorrelationId,
                topic: message.topic,
                partition: message.partition,
                timestamp: new Date().toISOString(),
              },
            );
          } catch (error) {
            const err = error as Error;
            this.logger.error(
              `Error processing message from topic ${message.topic}`,
              {
                error: err.stack,
                correlationId: messageCorrelationId,
                topic: message.topic,
                partition: message.partition,
              },
            );
            if (message.value) {
              await this.sendToDLQ(message.topic, message.value);
            }
          } finally {
            consumeNext();
          }
        })();
      });
    };

    consumeNext();
  }

  private async sendToDLQ(
    originalTopic: string,
    message: Buffer,
  ): Promise<void> {
    const dlqTopic = `${originalTopic}.dlq`;
    try {
      await this.produce(dlqTopic, {
        originalTopic,
        originalMessage: message.toString('base64'),
        error: 'Failed to process message',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const err = error as Error;
      this.logger.error('Failed to send message to DLQ', {
        error: err.stack,
        topic: dlqTopic,
      });
    }
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info('Starting Kafka graceful shutdown', { signal });
    const shutdownTimeout = 30000;

    try {
      this.logger.info('Stopping producer...');
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          this.producer.disconnect((err) => {
            if (err) {
              reject(
                this.normalizeError(
                  err,
                  'Kafka producer shutdown disconnect error',
                ),
              );
            } else {
              resolve();
            }
          });
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Producer disconnect timeout')),
            shutdownTimeout,
          ),
        ),
      ]);
      this.logger.info('Producer disconnected successfully');

      this.logger.info('Stopping consumers...');
      const consumerDisconnectPromises = Array.from(
        this.consumers.entries(),
      ).map(async ([groupId, consumer]) => {
        try {
          await Promise.race([
            new Promise<void>((resolve, reject) => {
              consumer.disconnect((err) => {
                if (err) {
                  reject(
                    this.normalizeError(
                      err,
                      `Kafka consumer ${groupId} shutdown disconnect error`,
                    ),
                  );
                } else {
                  resolve();
                }
              });
            }),
            new Promise((_, reject) =>
              setTimeout(
                () =>
                  reject(new Error(`Consumer ${groupId} disconnect timeout`)),
                shutdownTimeout,
              ),
            ),
          ]);
          this.logger.info(`Consumer ${groupId} disconnected successfully`);
        } catch (error) {
          const err = error as Error;
          this.logger.error(`Error disconnecting consumer ${groupId}`, {
            error: err.stack,
            groupId,
          });
        } finally {
          this.consumerLoops.delete(groupId);
        }
      });

      await Promise.all(consumerDisconnectPromises);
      this.logger.info('All Kafka connections closed successfully.');
    } catch (error) {
      const err = error as Error;
      this.logger.error('Error during Kafka shutdown', {
        error: err.stack,
        signal,
      });
      throw err;
    } finally {
      this.consumers.clear();
    }
  }

  async isConnected(): Promise<boolean> {
    try {
      await this.sendWithReconnect(
        () => {
          this.producer.produce(
            '__kafka_health_check',
            null,
            Buffer.from('health_check'),
            undefined,
            Date.now(),
          );
        },
        { topic: '__kafka_health_check' },
      );

      const consumersConnected = Array.from(this.consumers.values()).every(
        (consumer) => consumer.isConnected(),
      );

      return this.producer.isConnected() && consumersConnected;
    } catch (error) {
      const err = error as Error;
      this.logger.error('Failed to check Kafka connection status', {
        error: err.stack,
        timestamp: new Date().toISOString(),
      });
      return false;
    }
  }
}
