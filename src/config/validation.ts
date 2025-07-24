import * as Joi from 'joi';
import { CronExpression } from '@nestjs/schedule';

export const validationSchema = Joi.object({
  // App Configuration
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),
  LOG_LEVEL: Joi.string()
    .valid('error', 'warn', 'info', 'debug', 'verbose')
    .default('info'),
  LOG_DIR: Joi.string().default('logs'),

  // Kafka Configuration
  KAFKA_BROKERS: Joi.string().required(),
  KAFKA_CLIENT_ID: Joi.string().default('autopilot-service'),
  KAFKA_MAX_RETRY_TIME: Joi.number().default(30000),
  KAFKA_INITIAL_RETRY_TIME: Joi.number().default(300),
  KAFKA_RETRIES: Joi.number().default(5),

  // Schema Registry Configuration
  SCHEMA_REGISTRY_URL: Joi.string().required(),
  SCHEMA_REGISTRY_USER: Joi.string().optional().allow(''),
  SCHEMA_REGISTRY_PASSWORD: Joi.string().optional().allow(''),

  // Challenge API Configuration
  CHALLENGE_API_URL: Joi.string().uri().required(),
  CHALLENGE_API_M2M_TOKEN: Joi.string().optional(),
  // New: Validation for configurable API retries
  CHALLENGE_API_RETRY_ATTEMPTS: Joi.number().default(3),
  CHALLENGE_API_RETRY_DELAY: Joi.number().default(1000),

  // Sync Service Configuration
  SYNC_CRON_SCHEDULE: Joi.string().default(CronExpression.EVERY_5_MINUTES),
});
