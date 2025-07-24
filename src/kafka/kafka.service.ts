import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Consumer,
  Kafka,
  Producer,
  ProducerRecord,
  Partitioners,
} from 'kafkajs';
import { SchemaUtils } from '../common/utils/schema.utils';
import {
  KafkaConnectionException,
  KafkaProducerException,
  KafkaConsumerException,
  SchemaRegistryException,
} from '../common/exceptions/kafka.exception';
import { LoggerService } from '../common/services/logger.service';
import { CircuitBreaker } from '../common/utils/circuit-breaker';
import { v4 as uuidv4 } from 'uuid';
import { KAFKA_SCHEMAS } from '../common/schemas/kafka.schemas';
import { CONFIG } from '../common/constants/config.constants';
import { ISchemaCacheEntry, IKafkaConfig } from '../common/types/kafka.types';

@Injectable()
export class KafkaService implements OnApplicationShutdown, OnModuleInit {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly consumers: Map<string, Consumer>;
  private readonly schemaUtils: SchemaUtils;
  private readonly logger: LoggerService;
  private readonly circuitBreaker: CircuitBreaker;
  private schemaIds: Map<string, number>;
  private readonly schemaCache: Map<string, ISchemaCacheEntry>;

  constructor(private readonly configService: ConfigService) {
    this.logger = new LoggerService(KafkaService.name);
    this.schemaCache = new Map();

    try {
      const brokers = this.configService.get<string | undefined>(
        'kafka.brokers',
      );
      const kafkaBrokers = Array.isArray(brokers)
        ? brokers
        : brokers?.split(',') || CONFIG.KAFKA.DEFAULT_BROKERS;

      const kafkaConfig: IKafkaConfig = {
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

      this.kafka = new Kafka(kafkaConfig);

      this.producer = this.kafka.producer({
        createPartitioner: Partitioners.LegacyPartitioner,
        idempotent: true,
        maxInFlightRequests: CONFIG.KAFKA.DEFAULT_MAX_IN_FLIGHT_REQUESTS,
        transactionTimeout: CONFIG.KAFKA.DEFAULT_TRANSACTION_TIMEOUT,
        allowAutoTopicCreation: true,
      });

      this.consumers = new Map();
      this.circuitBreaker = new CircuitBreaker({
        failureThreshold: CONFIG.CIRCUIT_BREAKER.DEFAULT_FAILURE_THRESHOLD,
        resetTimeout: CONFIG.CIRCUIT_BREAKER.DEFAULT_RESET_TIMEOUT,
      });

      const schemaRegistryUrl = this.configService.get<string | undefined>(
        'kafka.schemaRegistry.url',
      );
      if (!schemaRegistryUrl) {
        this.logger.error('Schema registry URL is not configured');
        throw new SchemaRegistryException(
          'Schema registry URL is not configured',
        );
      }

      this.schemaUtils = new SchemaUtils(schemaRegistryUrl);
      this.schemaIds = new Map();
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
      await this.initializeSchemas();
      await this.producer.connect();
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

  private async initializeSchemas(): Promise<void> {
    try {
      this.logger.info('Initializing Kafka schemas...');

      for (const [topic, schema] of Object.entries(KAFKA_SCHEMAS)) {
        try {
          const schemaId = await this.schemaUtils.registerSchema(topic, schema);
          this.schemaIds.set(topic, schemaId);
          this.logger.info(
            `Schema initialized for topic ${topic} with ID: ${schemaId}`,
          );
        } catch (error) {
          if (
            error instanceof Error &&
            (error.message.includes('already exists') ||
              error.message.includes('incompatible'))
          ) {
            this.logger.warn(
              `Schema for topic ${topic} may already exist. Fetching latest version.`,
            );
            const schemaId = await this.schemaUtils.getLatestSchemaId(
              `${topic}-value`,
            );
            this.schemaIds.set(topic, schemaId);
            this.logger.info(
              `Using existing schema for topic ${topic} with ID: ${schemaId}`,
            );
          } else {
            throw error;
          }
        }
      }

      this.logger.info('All Kafka schemas initialized successfully');
    } catch (error) {
      const err = error as Error;
      this.logger.error('Failed to initialize Kafka schemas', {
        error: err.stack || err.message,
      });
      throw new SchemaRegistryException(
        `Failed to initialize Kafka schemas: ${err.message}`,
        {
          error: err.stack || err.message,
        },
      );
    }
  }

  private async refreshSchemaId(topic: string): Promise<number> {
    try {
      const subject = `${topic}-value`;
      this.logger.info(`Refreshing schema for ${topic}`);

      const schemaId = await this.schemaUtils.getLatestSchemaId(subject);
      this.schemaIds.set(topic, schemaId);
      this.logger.info(`Schema refreshed for ${topic} with ID: ${schemaId}`);
      return schemaId;
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to refresh schema for ${topic}`, {
        error: err.stack || err.message,
      });
      throw new SchemaRegistryException(
        `Failed to refresh schema for ${topic}: ${err.message}`,
      );
    }
  }

  async sendMessage(topic: string, message: unknown): Promise<void> {
    try {
      const schemaId = this.schemaIds.get(topic);
      if (!schemaId) {
        throw new Error(`No schema ID found for topic ${topic}`);
      }

      const encodedMessage = await this.schemaUtils.encode(message, schemaId);
      await this.producer.send({
        topic,
        messages: [{ value: encodedMessage }],
      });
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

  async produce(topic: string, message: unknown): Promise<void> {
    const correlationId = uuidv4();

    try {
      await this.circuitBreaker.execute(async () => {
        try {
          await this.producer.send({
            topic: '__kafka_health_check',
            messages: [{ value: Buffer.from('health_check') }],
          });
        } catch (error) {
          const err = error as Error;
          this.logger.warn(
            'Producer disconnected, attempting to reconnect...',
            { correlationId, error: err.stack || err.message },
          );
          await this.producer.connect();
        }

        let schemaId = this.schemaIds.get(topic);
        if (!schemaId) {
          this.logger.warn(
            `Schema ID not found for topic ${topic}, refreshing...`,
          );
          try {
            schemaId = await this.refreshSchemaId(topic);
          } catch (error) {
            const err = error as Error;
            this.logger.error(
              `Failed to refresh schema ID for topic ${topic}`,
              { error: err.stack || err.message },
            );
            throw new SchemaRegistryException(
              `Failed to get schema ID for topic ${topic}: ${err.message}`,
            );
          }
        }

        const encodedValue = await this.schemaUtils.encode(message, schemaId);
        const record: ProducerRecord = {
          topic,
          messages: [
            {
              value: encodedValue,
              headers: {
                'correlation-id': correlationId,
                timestamp: Date.now().toString(),
              },
            },
          ],
          acks: -1,
          timeout: 30000,
        };

        await this.producer.send(record);

        this.logger.info(`[KAFKA-PRODUCER] Message produced to ${topic}`, {
          correlationId,
          topic,
          timestamp: new Date().toISOString(),
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
        let schemaId = this.schemaIds.get(topic);
        if (!schemaId) {
          this.logger.warn(
            `Schema ID not found for topic ${topic}, refreshing...`,
          );
          try {
            schemaId = await this.refreshSchemaId(topic);
          } catch (error) {
            const err = error as Error;
            this.logger.error(
              `Failed to refresh schema ID for topic ${topic}`,
              { error: err.stack || err.message },
            );
            throw new SchemaRegistryException(
              `Failed to get schema ID for topic ${topic}: ${err.message}`,
            );
          }
        }

        this.logger.info(`Producing batch to ${topic}`, {
          correlationId,
          count: messages.length,
        });

        const encodedMessages = await Promise.all(
          messages.map(async (message) => ({
            value: await this.schemaUtils.encode(message, schemaId),
            headers: {
              'correlation-id': correlationId,
              timestamp: Date.now().toString(),
            },
          })),
        );

        const record: ProducerRecord = {
          topic,
          messages: encodedMessages,
          acks: -1,
          timeout: 30000,
        };

        await this.producer.send(record);
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
          consumer = this.kafka.consumer({
            groupId,
            maxWaitTimeInMs: CONFIG.KAFKA.DEFAULT_MAX_WAIT_TIME,
            maxBytes: CONFIG.KAFKA.DEFAULT_MAX_BYTES,
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
          });

          await consumer.connect();
          this.consumers.set(groupId, consumer);
        }

        await consumer.subscribe({ topics, fromBeginning: false });

        await consumer.run({
          eachMessage: async ({ topic, partition, message }) => {
            const messageCorrelationId =
              message.headers?.['correlation-id']?.toString() || uuidv4();

            try {
              if (!message.value) {
                throw new Error('Message value is null or undefined');
              }

              const decodedMessage = (await this.schemaUtils.decode(
                message.value,
              )) as Record<string, unknown>;

              if (!decodedMessage) {
                throw new Error('Decoded message is null or undefined');
              }

              this.logger.info(
                `[KAFKA-CONSUMER] Starting to process message from ${topic}`,
                {
                  correlationId: messageCorrelationId,
                  topic,
                  partition,
                  timestamp: new Date().toISOString(),
                },
              );

              await onMessage(decodedMessage);

              this.logger.info(
                `[KAFKA-CONSUMER] Completed processing message from ${topic}`,
                {
                  correlationId: messageCorrelationId,
                  topic,
                  partition,
                  timestamp: new Date().toISOString(),
                },
              );
            } catch (error) {
              const err = error as Error;
              this.logger.error(
                `Error processing message from topic ${topic}`,
                {
                  error: err.stack,
                  correlationId: messageCorrelationId,
                  topic,
                  partition,
                },
              );
              if (message.value) {
                await this.sendToDLQ(topic, message.value);
              }
            }
          },
        });
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
        this.producer.disconnect(),
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
            consumer.disconnect(),
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
      await this.producer.send({
        topic: '__kafka_health_check',
        messages: [{ value: Buffer.from('health_check') }],
      });

      const admin = this.kafka.admin();
      await admin.connect();
      const consumerGroups = await admin.listGroups();
      await admin.disconnect();
      const groupIds = Array.from(this.consumers.keys());

      const allConsumersConnected = groupIds.every((groupId) =>
        consumerGroups.groups.some((group) => group.groupId === groupId),
      );

      return allConsumersConnected;
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
