# PM-6308: Review remains open during Appeals

## Findings

The ticket shows challenge `030e5a1c-f44b-4cf3-bca9-8996ad5660de` with Review and
Appeals both open after reviewers finished their work. QA subsequently closed
Review manually.

Two lifecycle gaps exist in `develop`:

1. `ChallengeApiService.advancePhase(..., 'open')` checked only `isOpen`. A
   delayed or duplicated phase-chain callback could reopen a completed Review,
   clear its `actualEndDate`, and extend its scheduled end, while Appeals stayed
   open. This also applied if Review completed between the initial read and the
   transaction. The final review completion event had already been handled, so
   there was no new event to close it again.
2. Periodic challenge reconciliation only closed completed Marathon Match review
   phases early. An ordinary Review or Checkpoint Review left open after a
   missed completion event or a stale open had to wait for its scheduled close.

Automatic opens now reject a non-null `actualEndDate`, including in the atomic
update predicate. Challenge-update reconciliation also detects completed human
Review and Checkpoint Review work, then uses the normal scheduler close path.
That path retains reviewer coverage, pending review, and AI escalation checks.
It reloads the challenge after each batch of close attempts, preserving any
Appeals phase that is already open. Iterative, approval, and post-mortem work
retain their separate completion handlers. Manual reopening remains a
challenge-api operation; a completed phase is not reopened by replaying START.

## Review API investigation and change history

`review-api-v6` at `41d6853` publishes `review.action.completed` when a review is
created as COMPLETED or transitions to COMPLETED. The payload uses the review's
challenge phase instance ID, which Autopilot resolves before closing that phase.
Existing review API tests cover both publication paths.

The most recent change around publication was `e550bf7d` (2026-08-13), which
enqueues Design submission previews before publishing. That helper catches its
own failures, so the code does not establish that this change broke publication.

The incomplete phase-open guard predates the recent fixes: it was introduced in
Autopilot `18d952e1` (2025-09-24), and the conditional transaction added by
`bac88fd8` (2026-01-08) still guarded only `isOpen`. PM-5787's `7cc6507` (2026-08-20) concerns
Screening assignment and does not explain reopening a completed Review.

No recent commit has been proven to cause the reported incident. The stale-open
path is a reproducible code defect consistent with the screenshot, not a claim
that the incident's exact event order has been recovered. Live AWS logs could
not be read because the local AWS session was expired, and an unauthenticated
read of the sample challenge returned HTTP 403.

## Regression coverage and QA

- Reject a delayed Review open while Appeals is open.
- Guard against completion between the initial read and the conditional update.
- Reconcile completed Review and Checkpoint Review even while Appeals is open.
- Keep incomplete work, empty review phases, and iterative workflows out of the
  new human-review reconciliation path.
- Preserve existing Marathon Match readiness and scheduler closure tests.

For dev QA, complete every review before its scheduled deadline. Review should
close and Appeals should open once. Replay the original Review START event;
Review must stay closed with its original actual end time. On an active test
challenge with completed Review work left open, a normal reconciliation should
close Review without changing an already-open Appeals phase. Repeat with one
pending review and with a pending escalation; Review must remain open.
