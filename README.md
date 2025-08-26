# Autopilot Service

autopilot operations with Kafka integration.

## Features

- **Event-Driven Scheduling**: Dynamically schedules phase transitions using `@nestjs/schedule`.
- **Kafka Integration**: Utilizes Kafka with JSON serialization for robust, lightweight messaging.
- **Challenge API Integration**: Fetches live challenge data, with resilient API calls featuring exponential backoff and rate-limiting handling.
- **Recovery and Synchronization**: Includes a recovery service on startup and a periodic sync service to ensure data consistency.
- **Health Checks**: Provides endpoints to monitor application and Kafka connection health.
- **Structured Logging**: Uses Winston for detailed and configurable logging.

## Prerequisites

- Node.js (v18 or higher)
- Docker and Docker Compose

## Installation

### 1. Prerequisites

- Node.js v20 or higher
- Docker and Docker Compose

### 2. Environment Setup

Create a `.env` file in the root directory:

```bash
cp .env.example .env
```

Open the `.env` file and configure the variables for your environment. It is crucial to set valid Auth0 credentials.

   ```plaintext
   # -------------------------------------
   # App Configuration
   # -------------------------------------
   NODE_ENV=development
   PORT=3000
   LOG_LEVEL=debug
   LOG_DIR=logs
   # Enable file logging in production environments (default: false)
   # In development environments, file logging is enabled by default
   ENABLE_FILE_LOGGING=false

   # -------------------------------------
   # Kafka Configuration
   # -------------------------------------
   KAFKA_BROKERS=localhost:9092
   KAFKA_CLIENT_ID=autopilot-service

   # -------------------------------------
   # Challenge API Configuration
   # -------------------------------------
   CHALLENGE_API_URL=https://api.topcoder-dev.com/v6
   CHALLENGE_API_RETRY_ATTEMPTS=3
   CHALLENGE_API_RETRY_DELAY=1000

   # -------------------------------------
   # Auth0 Configuration
   # -------------------------------------
   AUTH0_URL=<your-auth0-url> # <-- IMPORTANT: REPLACE THIS
   AUTH0_CLIENT_ID=<your-auth0-client-id> # <-- IMPORTANT: REPLACE THIS
   AUTH0_CLIENT_SECRET=<your-auth0-client-secret> # <-- IMPORTANT: REPLACE THIS
   AUTH0_DOMAIN=<your-auth0-domain> # <-- IMPORTANT: REPLACE THIS
   AUTH0_AUDIENCE=<your-auth0-audience> # <-- IMPORTANT: REPLACE THIS
   AUTH0_PROXY_SEREVR_URL=

   # -------------------------------------
   # Sync Service Configuration
   # -------------------------------------
   SYNC_CRON_SCHEDULE='*/5 * * * *'
   ```

### 3. Install Dependencies

```bash
# Using pnpm
pnpm install
```

### 4. Development Setup

1. Start Kafka infrastructure using Docker Compose:
```bash
docker compose up -d
```

This will start:
- Zookeeper (port 2181)
- Kafka (ports 9092, 29092)
- Kafka UI (port 8080)

2. Verify Docker containers are healthy:
```bash
# Check container status
docker compose ps

# Check container logs for any errors
docker compose logs

# Verify Kafka UI is accessible
http://localhost:8080
```

3. Start the application locally:
```bash
# Using the start script
./start-local.sh

# Or manually with environment variables
npm run start:dev
```

### 5. Verify Installation

1. Check if the application is running:

- **API Documentation (Swagger)**: `http://localhost:3000/api-docs`
- **Health Check**: `http://localhost:3000/health`
- **Kafka UI**: `http://localhost:8080`

# Test coverage

## Scripts


- **Run end-to-end tests**:

   ```bash
   npm run test:e2e
   ```
  
- **Run lint**:

```bash
# Lint
$ npm run lint

```

## API Endpoints

### Health Checks

- `GET /health` - Overall health check including Kafka
- `GET /health/kafka` - Kafka-specific health check
- `GET /health/app` - Application health check

## Core Components & Kafka Topics

The service is composed of several key modules that communicate over specific Kafka topics.

| Service              | Responsibility                                                                 | Consumes Topics                                    | Produces Topics           |
|----------------------|-------------------------------------------------------------------------------|----------------------------------------------------|---------------------------|
| ChallengeApiService  | Handles all communication with the external Topcoder Challenge API.            | -                                                  | -                         |
| AutopilotService     | Central business logic for scheduling, updating, and canceling phase transitions. | challenge.notification.create, challenge.notification.update, autopilot.command | -                         |
| SchedulerService     | Low-level job management using setTimeout. Triggers Kafka events when jobs execute. | -                                                  | autopilot.phase.transition |
| RecoveryService      | Runs on startup to sync all active challenges from the API, scheduling them and processing overdue phases. | -                                                  | autopilot.phase.transition |
| SyncService          | Runs a periodic cron job to reconcile the scheduler's state with the Challenge API. | -                                                  | -                         |
| KafkaService         | Manages all Kafka producer/consumer connections with JSON serialization. | All                                                | All                       |


## Project Structure

```
src/
├── app.module.ts              # Root application module
├── main.ts                    # Application entry point
├── config/                    # Configuration files
│   ├── configuration.ts       # Main configuration
│   ├── validation.ts         # Environment validation
│   └── sections/             # Configuration sections
├── kafka/                    # Kafka related code
│   ├── kafka.module.ts       # Kafka module
│   ├── kafka.service.ts      # Kafka service
│   ├── consumers/           # Kafka consumers
│   └── producers/           # Kafka producers
├── common/                   # Common utilities
│   ├── constants/           # Constants
│   ├── exceptions/          # Custom exceptions
│   ├── filters/             # Exception filters
│   ├── interceptors/        # Interceptors
│   ├── interfaces/          # TypeScript interfaces
│   ├── services/            # Common services
│   └── utils/               # Utility functions
└── autopilot/               # Autopilot specific code
    ├── autopilot.module.ts  # Autopilot module
    ├── services/           # Autopilot services
    └── interfaces/         # Autopilot interfaces

test/                        # Test files
├── jest-e2e.json           # Jest E2E configuration
└── app.e2e-spec.ts         # E2E test specifications

.env                         # Environment variables
.env.example                 # Example env template
```

## JSON Messaging Architecture

The service uses a simplified JSON-based messaging approach that aligns with organizational standards and provides several benefits:

### Benefits of JSON Messaging

- **Simplified Infrastructure**: No need for Schema Registry, reducing deployment complexity
- **AWS Compatibility**: Works seamlessly with AWS-native Kafka solutions like MSK
- **Standard Format**: Uses widely-adopted JSON format for better interoperability
- **Reduced Dependencies**: Eliminates Confluent-specific dependencies
- **Enhanced Performance**: Lower overhead compared to Avro serialization with Schema Registry lookups

### Message Structure

All Kafka messages follow a consistent JSON structure:

```json
{
  "topic": "autopilot.phase.transition",
  "originator": "auto_pilot",
  "timestamp": "2023-12-01T10:00:00.000Z",
  "mimeType": "application/json",
  "payload": {
    // Topic-specific payload data
  }
}
```

### Message Validation

- **TypeScript Interfaces**: Strong typing maintained through TypeScript interfaces
- **Class Validators**: Runtime validation using class-validator decorators
- **JSON Schema**: Implicit schema validation through TypeScript compilation
- **Error Handling**: Robust error handling for malformed JSON messages with DLQ support
package.json                 # Dependencies and scripts
tsconfig.json               # TypeScript config
README.md                   # Documentation
```

## Logging Configuration

The autopilot service uses a flexible logging strategy that adapts to different deployment environments:

### Development Environment
- **File Logging**: Enabled by default for debugging purposes
- **Console Logging**: Always enabled with colorized output
- **Log Files**: Created in the `logs/` directory (configurable via `LOG_DIR`)

### Production Environment (ECS)
- **File Logging**: Disabled by default to support read-only filesystems
- **Console Logging**: Primary logging method, suitable for container log collection
- **Override**: Set `ENABLE_FILE_LOGGING=true` to enable file logging if the filesystem is writable

### Environment Variables
- `LOG_LEVEL`: Controls log verbosity (`error`, `warn`, `info`, `debug`, `verbose`)
- `LOG_DIR`: Directory for log files (default: `logs`)
- `ENABLE_FILE_LOGGING`: Boolean flag to control file logging in production

### ECS Deployment Notes
When deploying to ECS, ensure:
1. `NODE_ENV=production` is set
2. `ENABLE_FILE_LOGGING` is either unset or set to `false` for read-only filesystems
3. Container logging is configured to collect stdout/stderr logs

## Further Documentation

For more detailed technical information, please see the documents in the `docs/` directory:

- `docs/CHALLENGE_API_INTEGRATION.md`: A deep dive into the integration with the Challenge API, recovery, and sync services.
- `docs/SCHEDULER.md`: Detailed explanation of the event-based scheduling architecture.

## Troubleshooting

- **Schema Incompatibility Error**: If you encounter this during startup, your local Schema Registry Docker volume may have a stale schema. To fix this, reset the Docker volumes:

   ```bash
   docker compose down -v
   ```

  Then restart the services with:

   ```bash
   docker compose up -d
   ```

- **API Authentication Errors**: Ensure Auth0 credentials (`AUTH0_URL`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_AUDIENCE`) in your `.env` file are valid and not expired.

- **ECS Deployment - Read-only Filesystem Error**: If the application fails to start in ECS with errors about creating a 'logs' directory:
  - Ensure `NODE_ENV=production` is set in your ECS task definition
  - Verify `ENABLE_FILE_LOGGING` is not set or is set to `false`
  - Check that your ECS task definition is configured to collect logs from stdout/stderr

- **Logging Issues**:
  - **No log files in development**: Check that `ENABLE_FILE_LOGGING` is not set to `false`
  - **File permission errors**: Ensure the application has write permissions to the `LOG_DIR` directory
  - **Missing logs in production**: Verify your container logging configuration is collecting stdout/stderr output
