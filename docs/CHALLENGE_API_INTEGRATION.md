# Challenge Data Integration Documentation

This document outlines how the Autopilot service interacts with the Topcoder Challenge database after removing the external Challenge API dependency.

## 1. Overview

Autopilot now queries the Challenge database directly through Prisma. This approach eliminates HTTP latency, removes the need for Auth0 tokens and retry logic, and gives the service an authoritative view of challenge and phase data. The database is accessed through a dedicated Prisma schema (`prisma/challenge.schema.prisma`) and runtime client (`ChallengePrismaService`).

## 2. Core Components

### ChallengeApiService

- **File**: `src/challenge/challenge-api.service.ts`
- **Responsibility**: Provides challenge lookups and phase mutations backed by direct database access.
- **Key Behaviors**:
  - **Direct Queries**: Uses Prisma to fetch challenges, phases, and related metadata without making HTTP calls.
  - **Phase Mapping**: Normalises Prisma models into the existing `IChallenge`/`IPhase` interfaces used across Autopilot.
  - **Phase Advancement**: Updates phase state (`isOpen`, `actualStartDate`, `actualEndDate`) and maintains `Challenge.currentPhaseNames` inside a transaction. Returns successor phases for scheduling chains and flags whether the challenge already has winners.

### RecoveryService

- **File**: `src/recovery/recovery.service.ts`
- **Responsibility**: On application startup it queries `ChallengeApiService` for all ACTIVE challenges to rebuild the scheduler state.
- **Logic**:
  1. Fetch all active challenges from the database.
  2. For each phase of each challenge:
     - If the `scheduledEndDate` is in the past, immediately trigger an `autopilot.phase.transition` Kafka event via `SchedulerService` so overdue transitions are handled.
     - If the phase is upcoming, schedule a new transition job with `AutopilotService`.

### SyncService

- **File**: `src/sync/sync.service.ts`
- **Responsibility**: Runs a cron job (configured through `SYNC_CRON_SCHEDULE`) to keep the in-memory scheduler aligned with the latest challenge data.
- **Logic**:
  1. Fetch all ACTIVE challenges from the database through `ChallengeApiService`.
  2. Compare active phases with the currently scheduled jobs.
  3. Reconcile differences:
     - **New/Updated Phases**: Schedule or reschedule jobs when timing or state changes.
     - **Obsolete Jobs**: Cancel jobs that no longer have corresponding active phases.
  4. Log a summary of the changes (added, updated, removed).

## 3. Kafka Event Handling

`AutopilotConsumer` listens to Kafka topics and reacts to challenge mutations.

- **File**: `src/kafka/consumers/autopilot.consumer.ts`

### challenge.notification.create

- **Trigger**: A new challenge is created in Topcoder.
- **Action**:
  1. `AutopilotService.handleNewChallenge` is invoked.
  2. It queries `ChallengeApiService` for the new challenge data.
  3. Each phase is scheduled based on its `scheduledEndDate`.

### challenge.notification.update

- **Trigger**: An existing challenge is updated (phase timing, status, etc.).
- **Action**:
  1. `AutopilotService.handleChallengeUpdate` loads the latest challenge state via `ChallengeApiService`.
  2. Phases are iterated and `reschedulePhaseTransition` is called when timing or state changes.

## 4. Environment & Configuration

- **Database URL**: `CHALLENGE_DB_URL` must point to the Challenge database. A test default is provided to ease local testing, but production deployments must supply a real connection string.
- **Prisma Schema**: The full Challenge schema lives in `prisma/challenge.schema.prisma`. Run `npx prisma generate --schema prisma/challenge.schema.prisma` after updating dependencies to materialise the client.

## 5. Operational Notes

- With the API removed, Auth0 configuration is no longer required for challenge operations. Existing Auth0 settings remain available for other parts of the service if needed.
- Retry and backoff logic was deleted because Prisma handles connectivity, and failures now surface immediately to the caller.
- Phase advancement is intentionally conservative: it only updates the targeted phase and returns successor phases whose predecessor matches the closed phase and are not already open or completed. Downstream scheduling logic remains unchanged.
