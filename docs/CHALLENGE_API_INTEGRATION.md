# Challenge API Integration Documentation

This document outlines the integration strategy between the Autopilot service and the Topcoder Challenge API.

## 1. Overview

The integration enables the Autopilot service to dynamically schedule and manage challenge phase transitions based on real-time data from the Challenge API. This is achieved through a combination of listening to Kafka events for immediate updates and a periodic synchronization process for ensuring data consistency.

## 2. Core Components

### ChallengeApiService

- **File**: `src/challenge/challenge-api.service.ts`
- **Responsibility**: Acts as the primary client for all interactions with the external Challenge API.
- **Key Features**:
  - **Robust Retries**: Implements an exponential backoff strategy for retrying failed API requests, making the service resilient to transient network issues. Retry logic is configurable via `.env` variables.
  - **Rate Limiting Handling**: Specifically detects HTTP 429 (Too Many Requests) responses and respects the `Retry-After` header if provided.
  - **Endpoint Integration**: Provides methods to interact with key Challenge API endpoints:
    - `GET /challenges`: Fetches challenges with filtering capabilities (e.g., `status=ACTIVE`).
    - `GET /challenges/:challengeId`: Fetches detailed information for a single challenge.

### RecoveryService

- **File**: `src/recovery/recovery.service.ts`
- **Responsibility**: On application startup, it queries the `ChallengeApiService` to get all ACTIVE challenges and establish the initial scheduler state.
- **Logic**:
  1. Fetches all active challenges from the API.
  2. For each phase of each challenge:
     - If the phase's `scheduledEndDate` is in the past, it immediately triggers an `autopilot.phase.transition` Kafka event via the `SchedulerService` to ensure overdue actions are processed.
     - If the `scheduledEndDate` is in the future, it schedules a new transition job with the `AutopilotService`.

### SyncService

- **File**: `src/sync/sync.service.ts`
- **Responsibility**: Runs a cron job on a configurable schedule (defined by `SYNC_CRON_SCHEDULE` in `.env`) to ensure the scheduler's state is consistent with the Challenge API.
- **Logic**:
  1. Fetches all ACTIVE challenges from the `ChallengeApiService`.
  2. Fetches all currently scheduled jobs from the `SchedulerService`.
  3. Reconciles Data:
     - **New/Updated Phases**: If an active phase from the API doesn't have a corresponding scheduled job, or if its end time has changed, a new job is scheduled (or the existing one is rescheduled).
     - **Obsolete Jobs**: If a scheduled job exists for a challenge or phase that is no longer active (or has been removed), it is cancelled and removed from the scheduler.
  4. **Auditing**: A summary of actions (added, updated, removed) is logged at the end of each run.

## 3. Kafka Event Handling

The `AutopilotConsumer` listens to the following Kafka topics to react to real-time changes.

- **File**: `src/kafka/consumers/autopilot.consumer.ts`

### challenge.notification.create

- **Trigger**: A new challenge is created in the Topcoder platform.
- **Action**:
  1. The `handleNewChallenge` method in `AutopilotService` is invoked.
  2. It uses the `challengeId` from the message to fetch the full challenge details from the `ChallengeApiService`.
  3. It iterates through all phases of the new challenge and schedules a transition job for each one based on its `scheduledEndDate`.

### challenge.notification.update

- **Trigger**: An existing challenge is updated (e.g., phase times are changed, status is modified).
- **Action**:
  1. The `handleChallengeUpdate` method in `AutopilotService` is invoked.
  2. It fetches the latest challenge details from the `ChallengeApiService`.
  3. It iterates through the phases and calls `reschedulePhaseTransition` for each one. This method intelligently cancels the old job and creates a new one if the end time has changed.
