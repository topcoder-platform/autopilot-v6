/**
 * Submission data needed to enforce a per-member review limit.
 */
export interface RankedSubmission {
  id: string;
  submissionRank: number;
}

/**
 * Select submission IDs that fall within a per-member submission limit.
 * @param submissions Ranked submissions returned by the review database. Rank
 * one is the newest submission for its member and submission type.
 * @param maxSubmissionsPerMember Positive maximum submissions per member, or
 * `null` when every submission is eligible.
 * @returns Unique eligible submission IDs in the input order.
 * @throws Never. Invalid ranks and blank IDs are ignored.
 */
export function selectSubmissionIdsWithinLimit(
  submissions: readonly RankedSubmission[],
  maxSubmissionsPerMember: number | null,
): string[] {
  const selectedIds = submissions
    .filter((submission) => {
      const hasValidRank =
        Number.isInteger(submission.submissionRank) &&
        submission.submissionRank > 0;
      if (!hasValidRank) {
        return false;
      }

      if (maxSubmissionsPerMember === null) {
        return true;
      }

      return submission.submissionRank <= maxSubmissionsPerMember;
    })
    .map((submission) => submission.id)
    .filter((submissionId): submissionId is string => Boolean(submissionId));

  return Array.from(new Set(selectedIds));
}
