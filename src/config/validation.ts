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
  ENABLE_FILE_LOGGING: Joi.boolean().default(false),

  // Kafka Configuration
  KAFKA_BROKERS: Joi.string().required(),
  KAFKA_CLIENT_ID: Joi.string().default('autopilot-service'),
  KAFKA_MAX_RETRY_TIME: Joi.number().default(30000),
  KAFKA_INITIAL_RETRY_TIME: Joi.number().default(300),
  KAFKA_RETRIES: Joi.number().default(5),

  // Challenge DB Configuration
  CHALLENGE_DB_URL: Joi.string()
    .uri()
    .when('NODE_ENV', {
      is: 'test',
      then: Joi.optional().default('postgresql://localhost:5432/challenge'),
      otherwise: Joi.required(),
    }),
  REVIEW_DB_URL: Joi.string()
    .uri()
    .when('NODE_ENV', {
      is: 'test',
      then: Joi.optional().default('postgresql://localhost:5432/review'),
      otherwise: Joi.required(),
    }),
  RESOURCES_DB_URL: Joi.string()
    .uri()
    .when('NODE_ENV', {
      is: 'test',
      then: Joi.optional().default('postgresql://localhost:5432/resources'),
      otherwise: Joi.required(),
    }),
  REVIEWER_POLL_INTERVAL_MS: Joi.number()
    .integer()
    .positive()
    .default(5 * 60 * 1000),

  // Auth0 Configuration (optional in test environment)
  AUTH0_URL: Joi.string()
    .uri()
    .when('NODE_ENV', {
      is: 'test',
      then: Joi.optional().default('https://test.auth0.com/oauth/token'),
      otherwise: Joi.required(),
    }),
  AUTH0_CLIENT_ID: Joi.string().when('NODE_ENV', {
    is: 'test',
    then: Joi.optional().default('test-client-id'),
    otherwise: Joi.required(),
  }),
  AUTH0_CLIENT_SECRET: Joi.string().when('NODE_ENV', {
    is: 'test',
    then: Joi.optional().default('test-client-secret'),
    otherwise: Joi.required(),
  }),
  AUTH0_DOMAIN: Joi.string().when('NODE_ENV', {
    is: 'test',
    then: Joi.optional().default('test.auth0.com'),
    otherwise: Joi.required(),
  }),
  AUTH0_AUDIENCE: Joi.string().when('NODE_ENV', {
    is: 'test',
    then: Joi.optional().default('https://test-api.topcoder.com'),
    otherwise: Joi.required(),
  }),
  AUTH0_PROXY_SEREVR_URL: Joi.string().optional().allow(''),

  // Sync Service Configuration
  SYNC_CRON_SCHEDULE: Joi.string().default(CronExpression.EVERY_5_MINUTES),
});
