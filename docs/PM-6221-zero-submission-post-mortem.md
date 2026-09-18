# PM-6221: Recover zero-submission challenges

A failure while preparing post-mortem after Submission closed previously allowed
normal phase chaining to open Review. Review then waited for completed reviews
that could never exist, while subsequent Submission END events were ignored
because the phase was already closed.

Challenge-update reconciliation now checks closed final Submission phases before
review readiness and successor scheduling. For an ACTIVE challenge with no
active contest submissions, it reuses the existing zero-submission workflow to
create Post-Mortem, create its pending reviews, cancel with the appropriate
zero-submissions or zero-registrations status, and schedule post-mortem closure.
A failed post-submission decision stops phase chaining and can be retried on the
next reconciliation.

Open or unstarted Submission phases, checkpoint-only challenges, Topgear tasks,
terminal challenges, and challenges that already have Post-Mortem are excluded.
Challenges with active contest submissions retain their normal review flow.
This changes future processing and reconciliation; it does not modify live data.

The ticket's example was already CANCELLED_CLIENT_REQUEST when inspected, so it
is deliberately outside automatic recovery. Verify using an ACTIVE challenge
with a completed Submission phase, zero contest submissions, and an open Review:
the next challenge update should replace downstream phases with Post-Mortem.
Also verify a populated challenge, an open Submission, and a cancelled challenge
retain their lifecycle. Simulating post-mortem setup failure must not open Review.
