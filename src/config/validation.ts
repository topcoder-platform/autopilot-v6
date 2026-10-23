import * as Joi from 'joi';
import { auth } from 'tc-core-library-js';
// Note: CronExpression enum is not required for string-based defaults

/**
 * Decide the M2M provider for a USE_KEYCLOAK value being validated, using the core's rule
 * (`auth.useKeycloak`): "true" in any case selects Keycloak; missing, empty or "false"
 * selects Auth0. The value is passed explicitly so settings from `.env` count too.
 * @param value The USE_KEYCLOAK value from the configuration under validation.
 * @returns True when Keycloak is selected.
 * @throws TypeError for any other value.
 */
const keycloakSelected = (value: unknown): boolean =>
  auth.useKeycloak({ USE_KEYCLOAK: value });

/**
 * Joi condition that matches only when USE_KEYCLOAK selects Keycloak. Unset, empty,
 * "false" and invalid values do not match; invalid values are reported by the
 * USE_KEYCLOAK key itself.
 */
const KEYCLOAK_SELECTED = Joi.any()
  .required()
  .custom((value: unknown, helpers) => {
    try {
      return keycloakSelected(value) ? value : helpers.error('any.invalid');
    } catch {
      return helpers.error('any.invalid');
    }
  });

/**
 * Apply a Keycloak setting's rules only in Keycloak mode; in Auth0 mode the setting is
 * optional and unchecked, as it was before the migration.
 * @param schema The setting's Keycloak-mode rules, including presence.
 * @returns The conditional schema for the validation object.
 */
const keycloakSetting = (schema: Joi.Schema): Joi.Schema =>
  Joi.any().when('USE_KEYCLOAK', {
    is: KEYCLOAK_SELECTED,
    then: schema,
    otherwise: Joi.any(),
  });

/**
 * Apply an Auth0 setting's pre-migration rules only in Auth0 mode: required, except under
 * NODE_ENV=test where it is optional with the given default. In Keycloak mode the
 * setting is optional and unchecked, as it was on the Keycloak-only branch.
 * @param schema The setting's Auth0-mode rules (without presence).
 * @param testDefault The default used when NODE_ENV=test.
 * @returns The conditional schema for the validation object.
 */
const auth0Setting = (schema: Joi.Schema, testDefault: string): Joi.Schema =>
  Joi.any().when('USE_KEYCLOAK', {
    is: KEYCLOAK_SELECTED,
    then: Joi.any(),
    otherwise: schema.when('NODE_ENV', {
      is: 'test',
      then: Joi.optional().default(testDefault),
      otherwise: Joi.required(),
    }),
  });

/**
 * Environment validation for ConfigModule. M2M settings follow USE_KEYCLOAK: `true`
 * requires the KEYCLOAK_* workload settings; unset or `false` requires the Auth0
 * settings exactly as the service did before the Keycloak migration. An invalid
 * USE_KEYCLOAK value fails startup.
 */
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
  KAFKA_CONNECTION_TIMEOUT: Joi.number().integer().positive().default(10000),
  KAFKA_REQUEST_TIMEOUT: Joi.number().integer().positive().default(30000),
  KAFKA_BROKER_TIMEOUT: Joi.number().integer().positive().default(5000),
  KAFKA_SESSION_TIMEOUT: Joi.number().integer().positive().default(60000),
  KAFKA_HEARTBEAT_INTERVAL: Joi.number().integer().positive().default(3000),
  KAFKA_MAX_WAIT_TIME: Joi.number().integer().positive().default(5000),

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
  MARATHON_MATCH_API_URL: Joi.string().uri().optional(),
  MARATHON_MATCH_API_TIMEOUT_MS: Joi.number()
    .integer()
    .positive()
    .default(15000),
  MARATHON_MATCH_SYSTEM_RESOURCE_ID: Joi.string().optional().allow(null, ''),
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

  // M2M provider switch: true = Keycloak, unset/empty/false = Auth0. Other values fail.
  USE_KEYCLOAK: Joi.any().custom((value: unknown) => {
    keycloakSelected(value);
    return value;
  }),

  // Keycloak workload configuration, required when USE_KEYCLOAK=true; test fixtures
  // are supplied by the test runner.
  KEYCLOAK_ISSUER: keycloakSetting(
    Joi.string()
      .uri({ scheme: ['https'] })
      .required(),
  ),
  KEYCLOAK_TOKEN_URL: keycloakSetting(
    Joi.string()
      .uri({ scheme: ['https'] })
      .required(),
  ),
  KEYCLOAK_AUDIENCE: keycloakSetting(Joi.string().required()),
  KEYCLOAK_CLIENT_ID: keycloakSetting(Joi.string().required()),
  KEYCLOAK_CLIENT_SECRET: keycloakSetting(Joi.string().required()),
  KEYCLOAK_SCOPE: keycloakSetting(Joi.string().optional()),

  // Auth0 Configuration, required when USE_KEYCLOAK is unset or false (optional in test environment)
  AUTH0_URL: auth0Setting(
    Joi.string().uri(),
    'https://test.auth0.com/oauth/token',
  ),
  AUTH0_CLIENT_ID: auth0Setting(Joi.string(), 'test-client-id'),
  AUTH0_CLIENT_SECRET: auth0Setting(Joi.string(), 'test-client-secret'),
  AUTH0_DOMAIN: auth0Setting(Joi.string(), 'test.auth0.com'),
  AUTH0_AUDIENCE: auth0Setting(Joi.string(), 'https://test-api.topcoder.com'),
  AUTH0_PROXY_SEREVR_URL: Joi.string().optional().allow(''),

  VALID_ISSUERS: Joi.string().optional(),
  AUTH_USER_AUDIENCES: Joi.string().optional(),
  AUTH_SECRET: Joi.string().optional(),
  ALLOW_LEGACY_USER_AUDIENCE: Joi.string().valid('true', 'false').optional(),

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
  MEMBER_API_URL: Joi.string().uri().optional(),
  MEMBER_API_TIMEOUT_MS: Joi.number().integer().positive().default(15000),

  // Sync Service Configuration
  // Default sync cadence set to every 3 minutes
  SYNC_CRON_SCHEDULE: Joi.string().default('*/3 * * * *'),
});
