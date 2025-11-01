import * as Joi from 'joi';
// Note: CronExpression enum is not required for string-based defaults

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
  DB_DEBUG: Joi.boolean().default(false),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .default('redis://127.0.0.1:6379'),
  REVIEW_APP_URL: Joi.string().uri().optional(),

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
  MEMBER_DB_URL: Joi.string()
    .uri()
    .when('NODE_ENV', {
      is: 'test',
      then: Joi.optional().default('postgresql://localhost:5432/members'),
      otherwise: Joi.required(),
    }),
  AUTOPILOT_DB_URL: Joi.string().uri().when('DB_DEBUG', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  REVIEWER_POLL_INTERVAL_MS: Joi.number()
    .integer()
    .positive()
    .default(5 * 60 * 1000),
  REVIEW_SUMMATION_API_URL: Joi.string(),
  REVIEW_SUMMATION_API_TIMEOUT_MS: Joi.number()
    .integer()
    .positive()
    .default(15000),
  POST_MORTEM_SCORECARD_ID: Joi.string().optional().allow(null, ''),
  TOPGEAR_POST_MORTEM_SCORECARD_ID: Joi.string().optional().allow(null, ''),
  POST_MORTEM_DURATION_HOURS: Joi.number().integer().positive().default(72),
  POST_MORTEM_REVIEW_ROLES: Joi.string().default('Reviewer,Copilot'),
  SUBMITTER_ROLE_NAMES: Joi.string().default('Submitter'),
  ITERATIVE_REVIEW_DURATION_HOURS: Joi.number()
    .integer()
    .positive()
    .default(24),
  // Optional default scorecard to use for First2Finish iterative reviews
  ITERATIVE_REVIEW_SCORECARD_ID: Joi.string().optional().allow(null, ''),
  APPEALS_PHASE_NAMES: Joi.string().default('Appeals'),
  APPEALS_RESPONSE_PHASE_NAMES: Joi.string().default('Appeals Response'),
  PHASE_NOTIFICATION_SENDGRID_TEMPLATE: Joi.string().optional(),

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

  // Bus API Configuration
  BUS_API_URL: Joi.string()
    .uri()
    .when('NODE_ENV', {
      is: 'test',
      then: Joi.optional().default('http://localhost:4000'),
      otherwise: Joi.required(),
    }),
  BUS_API_TIMEOUT_MS: Joi.number().integer().positive().default(10000),
  BUS_API_ORIGINATOR: Joi.string().default('autopilot-service'),

  // Finance API (optional but recommended)
  FINANCE_API_URL: Joi.string().uri().optional(),
  FINANCE_API_TIMEOUT_MS: Joi.number().integer().positive().default(15000),

  // Sync Service Configuration
  // Default sync cadence set to every 3 minutes
  SYNC_CRON_SCHEDULE: Joi.string().default('*/3 * * * *'),
});
