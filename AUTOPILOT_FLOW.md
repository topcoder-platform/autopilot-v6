# Autopilot Flow

This document maps the current stateful behavior in autopilot: why an action runs, what it changes, where it lives, and where duplicate or missing execution is most likely.

## Core files

- `src/autopilot/services/autopilot.service.ts`
- `src/autopilot/services/phase-schedule-manager.service.ts`
- `src/autopilot/services/scheduler.service.ts`
- `src/autopilot/services/phase-review.service.ts`
- `src/autopilot/services/resource-event-handler.service.ts`
- `src/autopilot/services/review-assignment.service.ts`
- `src/autopilot/services/first2finish.service.ts`
- `src/autopilot/services/challenge-completion.service.ts`
- `src/challenge/challenge-api.service.ts`
- `src/review/review.service.ts`

## Runtime entry points

| Source | Primary handler | Why it exists |
| --- | --- | --- |
| `challenge.notification.create` | `AutopilotService.handleNewChallenge` | Schedule the initial phase flow for a new challenge. |
| `challenge.notification.update` | `AutopilotService.handleChallengeUpdate` | Reconcile schedules and open review state after challenge changes. |
| `autopilot.challenge.update` | `AutopilotService.handleChallengeUpdate` | Same reconciliation path through a second topic. |
| `autopilot.phase.transition` | `AutopilotService.handlePhaseTransition` | Move a phase when a scheduled transition fires or is replayed. |
| `autopilot.command` | `AutopilotService.handleCommand` | Manual schedule cancellation or rescheduling. |
| `submission.notification.aggregate` | `AutopilotService.handleSubmissionNotificationAggregate` | Backfill review state and drive First2Finish / Topgear loops. |
| `first2finish.submission.received` | `AutopilotService.handleFirst2FinishSubmission` | Direct First2Finish submission handling. |
| `topgear.submission.received` | `AutopilotService.handleTopgearSubmission` | Direct Topgear submission handling. |
| `challenge.action.resource.create` | `AutopilotService.handleResourceCreated` | React to reviewer / approver assignment. |
| `challenge.action.resource.delete` | `AutopilotService.handleResourceDeleted` | React to reviewer removal. |
| `review.action.completed` | `AutopilotService.handleReviewCompleted` | Close phases early or continue approval / iterative loops. |
| `review.action.appeal.responded` | `AutopilotService.handleAppealResponded` | Close appeals-related phases when nothing is pending. |
| `aiworkflow.action.completed` | `AutopilotService.handleAiWorkflowCompleted` | Close AI Screening when all runs are done. |
| Startup recovery | `RecoveryService.onApplicationBootstrap` | Rebuild scheduler state after restart. |
| Cron sync | `SyncService.synchronizeChallenges` | Reconcile BullMQ jobs with challenge DB state. |

## Where mutations actually happen

- **Schedule state**: `PhaseScheduleManager` + `SchedulerService`
- **Phase row open/close**: `ChallengeApiService.advancePhase`
- **New phase insertion**: `ChallengeApiService.createPostMortemPhase*`, `createApprovalPhase`, `createFinalFixPhase*`, `createIterativeReviewPhase`
- **Pending review rows**: `PhaseReviewService` + `ReviewService.createPendingReview`
- **Challenge completion/cancellation**: `ChallengeCompletionService` + `ChallengeApiService.completeChallenge` / `cancelChallenge`

## Every reason a phase can be moved

### 1. Scheduled start or end time arrived

- **Why**: BullMQ job fired for a stored `challengeId|phaseId`.
- **Code**: `SchedulerService.runScheduledTransition`
- **What it does**:
  - reloads the phase and skips if it is already in the target state
  - publishes `autopilot.phase.transition`
  - directly calls `SchedulerService.advancePhase`
  - removes the job from the in-memory registry

### 2. A new challenge became ACTIVE

- **Why**: newly created challenge is ready for automation.
- **Code**: `PhaseScheduleManager.handleNewChallenge`
- **What it does**:
  - creates review opportunities if the challenge transitioned to `ACTIVE`
  - schedules the next relevant phase actions through `scheduleRelevantPhases`

### 3. A challenge update changed schedule or phase state

- **Why**: challenge timing, status, or open-phase metadata changed.
- **Code**: `PhaseScheduleManager.handleChallengeUpdate`
- **What it does**:
  - creates or re-checks review opportunities
  - triggers finance generation if the challenge entered a payable terminal status
  - immediately closes overdue open phases older than the grace period
  - reschedules relevant phase jobs
  - re-processes already-open Screening / Review / Approval phases to repair scorecards and missing pending reviews
  - checks whether all phases are now manually complete and the challenge should finalize

### 4. Recovery found a phase that should already start or end

- **Why**: service restarted and needs to catch up.
- **Code**: `RecoveryService.onApplicationBootstrap`
- **What it does**:
  - loads all active challenges
  - for each phase that should already be open or closed, either schedules it or immediately emits a phase-transition Kafka event

### 5. Sync found a missing, stale, or obsolete scheduled job

- **Why**: in-memory / Redis scheduler state drifted from challenge DB state.
- **Code**: `SyncService.synchronizeChallenges`
- **What it does**:
  - schedules missing jobs
  - reschedules jobs whose target date or state changed
  - cancels jobs for phases that are no longer active

### 6. A predecessor phase closed and successor phases should open

- **Why**: `ChallengeApiService.advancePhase(..., 'close')` returned successor phases.
- **Code**: `SchedulerService.advancePhase` -> `PhaseScheduleManager.openAndScheduleNextPhases`
- **What it does**:
  - opens successor phases
  - creates their pending reviews
  - auto-closes Appeals Response or AI Screening immediately if they have no work
  - schedules successor phase closure jobs

### 7. A review phase finished early

- **Why**: all pending reviews for an open Review or Screening phase are gone.
- **Code**: `AutopilotService.handleReviewCompleted`
- **What it does**:
  - closes the phase early via `SchedulerService.advancePhase`
  - skips the normal “must have completed review count” recheck because the close was review-driven

### 8. An Approval review finished

- **Why**: Approval is single-loop logic rather than normal successor chaining.
- **Code**: `AutopilotService.handleReviewCompleted`
- **What it does**:
  - closes the Approval phase immediately
  - if the review passed, closes any open Final Fix phases
  - if the review failed, creates a new Final Fix phase and waits for another submission

### 9. A Post-Mortem review phase finished

- **Why**: all Post-Mortem pending reviews are complete.
- **Code**: `AutopilotService.handleReviewCompleted`
- **What it does**:
  - closes the Post-Mortem phase
  - `SchedulerService.handlePostMortemPhaseClosed` may then set a zero-submission / zero-registration cancellation status if needed

### 10. An Iterative Review finished

- **Why**: First2Finish / Topgear drives challenge resolution from iterative reviews.
- **Code**: `First2FinishService.handleIterativeReviewCompletion`
- **What it does**:
  - closes the Iterative Review phase
  - if passing, closes Submission and Registration, then completes the challenge with the submitter as winner
  - if failing, prepares the next Iterative Review round

### 11. All appeal responses are done

- **Why**: nothing is left pending in appeals.
- **Code**: `AutopilotService.handleAppealResponded`
- **What it does**:
  - closes all open `Appeals` and `Appeals Response` phases for the challenge

### 12. All AI workflow runs are done

- **Why**: AI Screening has no remaining in-progress workflow runs.
- **Code**: `AutopilotService.handleAiWorkflowCompleted`
- **What it does**:
  - closes the open AI Screening phase early

### 13. A reviewer resource was added and a deferred phase is now ready

- **Why**: a Review or Screening phase was waiting for assignments.
- **Code**: `ResourceEventHandler.maybeOpenDeferredReviewPhases`
- **What it does**:
  - re-checks review/screening phases that are not open yet
  - opens them once predecessor, start-date, and reviewer-assignment conditions are satisfied

### 14. A challenge update discovered an overdue open phase

- **Why**: a schedule-driven phase is still open after its scheduled end.
- **Code**: `PhaseScheduleManager.processPastDueOpenPhases`
- **What it does**:
  - only targets phases that should close on schedule (`Registration`, `Submission`, `Checkpoint Submission`, configured `Appeals`)
  - cancels any stale scheduled job for that phase
  - immediately calls `SchedulerService.advancePhase(... END ...)`
  - does **not** use this immediate-close path for deliverable-driven phases like `Screening`, `Review`, `Approval`, `Iterative Review`, `Checkpoint Screening`, or `Checkpoint Review`

### 15. Topgear special handling keeps phases open longer

- **Why**: Topgear waits for a passing iterative review instead of normal timed closure.
- **Code**:
  - `SchedulerService.deferTopgearRegistrationPhaseClosure`
  - `SchedulerService.handleTopgearSubmissionLate`
- **What it does**:
  - defers scheduler-initiated Registration closure with backoff
  - skips scheduler-initiated Topgear Submission closure entirely and keeps the phase open

## Deferrals that move a phase later instead of now

These all reschedule another `START` or `END` attempt instead of moving the phase immediately.

| Case | Code | Why | What happens |
| --- | --- | --- | --- |
| Review close deferral | `SchedulerService.deferReviewPhaseClosure` | missing reviewer coverage, no completed reviews yet, pending reviews remain, or Marathon Match reviews are not ready | schedules another `END` attempt with backoff |
| Screening close deferral | `SchedulerService.deferScreeningPhaseClosure` | insufficient screener coverage or pending screening reviews | schedules another `END` attempt |
| Approval close deferral | `SchedulerService.deferApprovalPhaseClosure` | insufficient approver coverage, pending approvals, or zero completed approvals | schedules another `END` attempt |
| AI Screening close deferral | `SchedulerService.deferAiScreeningPhaseClosure` | AI runs still in progress | schedules another `END` attempt |
| Appeals close deferral | `SchedulerService.deferAppealsPhaseClosure` | pending appeals still exist | schedules another `END` attempt |
| Appeals open deferral | `SchedulerService.deferAppealsPhaseOpen` | predecessor review still has pending reviews | schedules another `START` attempt |
| Topgear Registration deferral | `SchedulerService.deferTopgearRegistrationPhaseClosure` | Topgear still waiting on passing iterative review | schedules another `END` attempt |
| Reviewer assignment polling | `ReviewAssignmentService.ensureAssignmentsOrSchedule` | a review phase cannot open until enough reviewers exist | starts a poller that tries to open later |

## Every reason reviews are created or changed

### Review opportunities

- **Why**: challenge became ACTIVE, or an ACTIVE challenge update is replayed.
- **Code**: `PhaseScheduleManager.createReviewOpportunitiesForChallenge`
- **What it does**:
  - fetches existing remote review opportunities
  - computes payment from first-place prize plus reviewer coefficients
  - creates missing opportunity types in review-api

### Standard Review / Screening phase opened

- **Why**: phase opened normally, was detected as already open, or got resynced after a submission / resource change.
- **Code**: `PhaseReviewService.handlePhaseOpenedForChallenge`
- **What it does**:
  - resolves reviewer configs and scorecard
  - resolves eligible submissions
  - for limited-submission challenges, keeps only the latest submission per member
  - deletes stale pending reviews whose submissions are no longer eligible for the phase
  - resolves reviewer resources for the phase role
  - inserts one `PENDING` review per `(resource, submission)` pair

### Checkpoint Screening opened

- **Why**: checkpoint submissions need screening.
- **Code**: `PhaseReviewService.handlePhaseOpenedForChallenge`
- **What it does**:
  - uses active checkpoint submissions
  - for limited-submission challenges, keeps only the latest checkpoint submission per member
  - deletes stale pending screening reviews for superseded checkpoint submissions
  - creates pending screening reviews for them

### Checkpoint Review opened

- **Why**: only checkpoint-passing submissions should be reviewed.
- **Code**: `PhaseReviewService.handlePhaseOpenedForChallenge`
- **What it does**:
  - finds checkpoint submissions that passed Checkpoint Screening
  - for limited-submission challenges, intersects that set with the latest checkpoint submission per member
  - deletes stale pending Checkpoint Review rows for superseded submissions
  - creates pending Checkpoint Review rows only for those submissions

### Approval opened

- **Why**: challenge reached Approval, or a continuation Approval was created.
- **Code**:
  - `PhaseReviewService.handlePhaseOpenedForChallenge`
  - `AutopilotService.createApprovalReviewsForSubmission`
- **What it does**:
  - finalizes review summations
  - generates review summaries
  - if no passing submission exists, finalizes/cancels the challenge instead of creating Approval reviews
  - otherwise creates Approval reviews only for the selected winning passing submission

### Post-Mortem opened

- **Why**: zero submissions, zero registrations, failed screening, or cancelled finalization requires Post-Mortem review.
- **Code**:
  - `PhaseReviewService.handlePhaseOpenedForChallenge`
  - `SchedulerService.createPostMortemPendingReviews*`
  - `ChallengeCompletionService.ensureCancelledPostMortem`
- **What it does**:
  - ensures `Post-Mortem Reviewer` resources exist for Reviewer / Copilot members
  - creates challenge-level pending reviews (`submissionId = null`)

### Marathon Match Review opened

- **Why**: Marathon Match uses one system review per latest submission.
- **Code**: `MarathonMatchReviewService.handleReviewPhaseOpened`
- **What it does**:
  - creates a pending SYSTEM review for each latest submission
  - triggers external system scoring for new or already-existing pending reviews

### Submission arrived during an open Screening / Review phase

- **Why**: a submission can appear after the phase is already open.
- **Code**: `AutopilotService.handleSubmissionNotificationAggregate`
- **What it does**:
  - on contest submissions, re-runs Screening review preparation
  - on checkpoint submissions, re-runs Checkpoint Screening preparation

### A review resource was added during an open phase

- **Why**: new reviewer / screener / checkpoint reviewer may need work immediately.
- **Code**: `ResourceEventHandler.handleResourceCreated`
- **What it does**:
  - re-runs pending-review preparation for currently open Review / Screening phases

### An Approver resource was added during Approval

- **Why**: pending Approval reviews should move to the newly assigned approver.
- **Code**: `ResourceEventHandler.handleResourceCreated`
- **What it does**:
  - reassigns pending Approval reviews to the new resource

### A reviewer resource was removed

- **Why**: pending reviews assigned to that resource are no longer valid.
- **Code**: `ResourceEventHandler.handleResourceDeleted`
- **What it does**:
  - deletes pending reviews for that resource
  - starts reviewer-assignment monitoring for the affected phase

### Open phase scorecard metadata changed

- **Why**: an already-open phase can get repaired through challenge-update reconciliation.
- **Code**: `PhaseScheduleManager.updatePendingReviewScorecards`
- **What it does**:
  - updates scorecard IDs on pending review rows for open Screening / Review / Approval phases

### First2Finish / Topgear iterative review assignment

- **Why**: a new eligible submission needs one iterative review.
- **Code**: `First2FinishService.processFirst2FinishSubmission`
- **What it does**:
  - finds the next eligible submission / reviewer pair
  - creates one pending Iterative Review
  - schedules Iterative Review closure

### Review row deduplication

- **Code**: `ReviewService.createPendingReview`
- **What it does**:
  - advisory-locks the `(phaseId, resourceId, submissionId, scorecardId)` tuple
  - inserts only if no non-completed matching review exists
  - returns the existing pending review ID if the pair already exists

## Every reason new phases are added

| New phase | Why | Code | What it does |
| --- | --- | --- | --- |
| `Post-Mortem` | Submission closed with zero active submissions | `SchedulerService.handleSubmissionPhaseClosed` -> `ChallengeApiService.createPostMortemPhase` | deletes future non-Post-Mortem phases after the predecessor, opens Post-Mortem immediately, creates PM reviews, cancels the challenge, schedules PM closure |
| `Post-Mortem` | Registration closed with zero submitters | `SchedulerService.handleRegistrationPhaseClosed` -> `createPostMortemPhase` | same phase creation path, but only Copilot-backed PM reviews are created |
| `Post-Mortem` | Screening closed and every active submission failed screening | `SchedulerService.handleScreeningPhaseClosed` -> `createPostMortemPhase` | cancels the challenge, opens Post-Mortem, creates PM reviews, schedules PM closure, triggers finance |
| `Post-Mortem` | Finalization cancelled a challenge with zero submissions or failed review | `ChallengeCompletionService.ensureCancelledPostMortem` -> `ChallengeApiService.createPostMortemPhasePreserving` | preserves future phases, optionally opens/reuses Post-Mortem, ensures PM reviews exist |
| `Approval` | Final Fix got a new submission and there is no open Approval phase | `AutopilotService.createApprovalForFinalFixSubmission` -> `ChallengeApiService.createApprovalPhase` | creates a new open Approval phase and immediately creates Approval reviews for the new submission |
| `Final Fix` | Approval review failed | `AutopilotService.ensureFollowUpFinalFixPhase` -> `ChallengeApiService.createFinalFixPhase*` | creates a new open Final Fix phase after Approval |
| `Iterative Review` | First2Finish / Topgear needs a new round | `First2FinishService.createNextIterativePhase` -> `ChallengeApiService.createIterativeReviewPhase` | creates a new open Iterative Review phase and then assigns one iterative review |

## Every reason a challenge outcome changes

### Normal completion

- **Why**: all phases are closed, there are no successor phases left, and finalization is not suppressed.
- **Code**: `SchedulerService.attemptChallengeFinalization` -> `ChallengeCompletionService.finalizeChallenge`
- **What it does**:
  - finalizes review summations
  - generates or rebuilds review summaries
  - selects placement winners and passed-review rows
  - marks the challenge `COMPLETED`
  - syncs `challengeResult` rows in review DB
  - triggers finance
  - refreshes / rerates winner stats
  - publishes `challenge.notification.update`

### Cancellation for zero submissions

- **Why**: Submission closed and there are no active contest submissions.
- **Code**: `SchedulerService.handleSubmissionPhaseClosed`
- **What it does**:
  - chooses `CANCELLED_ZERO_SUBMISSIONS` or `CANCELLED_ZERO_REGISTRATIONS`
  - creates/open Post-Mortem
  - creates Post-Mortem reviews
  - cancels the challenge

### Cancellation for zero registrations

- **Why**: Registration closed and there are no submitter resources.
- **Code**: `SchedulerService.handleRegistrationPhaseClosed`
- **What it does**:
  - creates/open Post-Mortem
  - creates Copilot Post-Mortem reviews
  - later `handlePostMortemPhaseClosed` can stamp the zero-registration cancellation status

### Cancellation for failed screening

- **Why**: every active submission failed screening.
- **Code**: `SchedulerService.handleScreeningPhaseClosed`
- **What it does**:
  - marks the challenge `CANCELLED_FAILED_SCREENING`
  - creates/open Post-Mortem
  - creates PM reviews
  - triggers finance generation

### Cancellation for failed review

- **Why**: finalization found review summaries but none are passing.
- **Code**: `ChallengeCompletionService.finalizeChallenge`
- **What it does**:
  - marks the challenge `CANCELLED_FAILED_REVIEW`
  - ensures Post-Mortem exists
  - triggers finance generation

### Checkpoint winners

- **Why**: Checkpoint Review closed.
- **Code**: `ChallengeCompletionService.assignCheckpointWinners`
- **What it does**:
  - computes top checkpoint scores
  - replaces checkpoint winner rows in the challenge DB

### Explicit completion from iterative review

- **Why**: First2Finish / Topgear got a passing iterative review.
- **Code**: `First2FinishService.completeFirst2FinishChallenge` -> `ChallengeCompletionService.completeChallengeWithWinners`
- **What it does**:
  - completes the challenge with the submitter as placement winner
  - still syncs results, triggers finance, refreshes stats, and publishes challenge update

## Other outbound or side-effecting actions

### Phase change notification emails

- **Why**: a phase was successfully opened or closed through `SchedulerService.advancePhase`.
- **Code**: `PhaseChangeNotificationService.sendPhaseChangeNotification`
- **What it does**:
  - resolves opted-in resources
  - resolves member emails
  - sends an external email event with challenge URL, phase name, and timestamp

### Finance generation

- **Why**:
  - challenge completed
  - challenge cancelled for failed review or failed screening
  - challenge transitioned into a payable terminal status through updates
  - sync replay is reconciling recent payable challenges
- **Code**:
  - `ChallengeCompletionService`
  - `SchedulerService.handleScreeningPhaseClosed`
  - `PhaseScheduleManager.triggerFinanceGenerationForPayableStatus`
  - `SyncService.reconcileRecentPayableChallenges`
- **What it does**:
  - calls finance-api to generate payments for the challenge

### Member stats refresh / rerate

- **Why**: challenge completed with winners.
- **Code**: `ChallengeCompletionService.triggerStatsRefreshForWinners`
- **What it does**:
  - refreshes winner stats in member-api
  - rerates winners if the challenge metadata marks it rated and the track/type pair is supported

### Challenge-result synchronization

- **Why**: challenge completed and review-api needs canonical participant results.
- **Code**: `ReviewService.syncChallengeResultsForChallenge`
- **What it does**:
  - builds one `challengeResult` row per user
  - upserts current rows
  - deletes stale rows that no longer map to a participant outcome

### Challenge completion Kafka update

- **Why**: downstream systems should see a completed challenge update.
- **Code**: `ChallengeCompletionService.publishChallengeCompletionUpdate`
- **What it does**:
  - publishes `challenge.notification.update` with winners and completion metadata

## Main dedupe / traceability mechanisms already in the code

- `SchedulerService.buildJobId` uses one BullMQ job ID per `challengeId|phaseId`
- `PhaseScheduleManager.schedulePhaseTransition` cancels an existing job before re-scheduling the same phase
- `ReviewService.createPendingReview` uses both an advisory lock and a `WHERE NOT EXISTS` insert
- `ReviewService.deletePendingReviewsExceptSubmissions` prunes stale pending reviews before fresh review rows are created
- `AutopilotService.createApprovalForFinalFixSubmission` uses `approvalResubmissionLocks` per challenge
- `ReviewAssignmentService` keeps one polling loop per `challengeId:phaseId`
- `SchedulerService` keeps retry maps for review, screening, approval, appeals, AI screening, registration, and finalization

## Known places where actions can run twice, race, or fail to run

### High-confidence duplicate / race hotspots

1. **Review creation is intentionally multi-entry**
   - It can be triggered by actual phase open, challenge update reconciliation, submission create, and reviewer resource create.
   - Safeguards now rely on both `ReviewService.createPendingReview` and stale-pending-review pruning against the currently eligible submission set.

2. **Finance generation is at-least-once**
   - It is triggered from completion/cancellation logic, payable challenge updates, and sync replay.

3. **First2Finish / Topgear submission handling has overlapping entry points**
   - Generic `submission.notification.aggregate` and dedicated `first2finish.submission.received` / `topgear.submission.received` can all reach `First2FinishService.handleSubmissionByChallengeId`.

### High-confidence “not running” or partial-hook hotspots

1. **Standard phase-chain openings bypass `SchedulerService.advancePhase`**
   - `PhaseScheduleManager.openPhaseAndSchedule` opens phases through `ChallengeApiService.advancePhase` directly.
   - That means normal successor opens do **not** send phase change notifications through `PhaseChangeNotificationService`.

2. **Dynamically created Approval / Final Fix phases are opened immediately but not scheduled there**
   - `createApprovalPhase` and `createFinalFixPhase*` open phases directly in the DB.
   - They rely on later sync / challenge update reconciliation to schedule closure.

3. **Cancelled-challenge Post-Mortem auto-close looks blocked**
   - `ChallengeApiService.advancePhase` only mutates `ACTIVE` challenges.
   - `AutopilotService.handleReviewCompleted` returns early for non-`ACTIVE` challenges.
   - Zero-submission / failed-review Post-Mortem flows cancel the challenge before expecting Post-Mortem closure logic.

4. **Reviewer-removal polling does not reopen by itself**
   - `ReviewAssignmentService.handleReviewerRemoved` starts a poller with a no-op callback.
   - Real reopening depends on later resource-created handling.

5. **`createPostMortemPhasePreserving` only partially honors `openImmediately` when the phase already exists**
   - if a Post-Mortem already exists, it returns that phase without reopening or rescheduling it

## Audit trail

- Many flows log to `autopilot.actions` through `AutopilotDbLoggerService`.
- To inspect one challenge’s recorded actions:

```bash
npm run pull:logs -- <challengeId>
```

That script reads from `autopilot.actions` in chronological order and is the fastest way to compare “what should have happened” against “what actually happened”.
