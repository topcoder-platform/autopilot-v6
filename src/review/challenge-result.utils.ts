/**
 * Flattened review/submission data needed to derive one `challengeResult` row
 * per member on a challenge.
 */
export interface ChallengeResultCandidate {
  submissionId: string;
  memberId: string | null;
  submittedDate: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  status: string | null;
  isLatest: boolean;
  initialScore: number;
  finalScore: number;
  passingScore: number;
  passedReview: boolean;
  validSubmission: boolean;
}

/**
 * Minimal winner data needed to map placement prizes back into challenge
 * result rows.
 */
export interface ChallengeResultPlacementWinner {
  userId: number;
  placement: number;
}

/**
 * Persistable `challengeResult` row shape used by the review DB writer.
 */
export interface ChallengeResultRecord {
  challengeId: string;
  userId: string;
  submissionId: string;
  initialScore: number;
  finalScore: number;
  placement: number;
  rated: boolean;
  passedReview: boolean;
  validSubmission: boolean;
  ratingOrder: number | null;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

interface CanonicalChallengeResultEntry {
  userId: string;
  candidate: ChallengeResultCandidate;
}

/**
 * Determine whether a submission status still represents a valid challenge
 * result candidate for member history.
 * @param status Submission status from review DB.
 * @returns `true` when the submission remained eligible past screening.
 * @throws Never.
 */
export function isValidChallengeResultStatus(status: string | null): boolean {
  const normalizedStatus = status?.trim().toUpperCase();
  if (!normalizedStatus || normalizedStatus === 'ACTIVE') {
    return true;
  }

  return ![
    'FAILED_SCREENING',
    'FAILED_CHECKPOINT_SCREENING',
    'FAILED_CHECKPOINT_REVIEW',
    'AI_FAILED_REVIEW',
    'DELETED',
  ].includes(normalizedStatus);
}

/**
 * Build canonical `challengeResult` rows from per-submission review data.
 * @param challengeId Challenge identifier for all rows.
 * @param candidates Per-submission review aggregates for the challenge.
 * @param placementWinners Placement winners from challenge completion data.
 * @param allowUnlimitedSubmissions Whether multiple reviewed submissions per member are allowed.
 * @param ratedChallenge Whether challenge metadata marks the challenge as rated.
 * @param actor Audit actor recorded on created/updated fields.
 * @param createdAt Timestamp used when creating new rows.
 * @param updatedAt Timestamp used for row updates.
 * @returns One canonical `challengeResult` row per member.
 * @throws Never.
 */
export function buildChallengeResultRecords(params: {
  challengeId: string;
  candidates: ChallengeResultCandidate[];
  placementWinners: ChallengeResultPlacementWinner[];
  allowUnlimitedSubmissions: boolean;
  ratedChallenge: boolean;
  actor: string;
  createdAt: Date;
  updatedAt: Date;
}): ChallengeResultRecord[] {
  const {
    challengeId,
    candidates,
    placementWinners,
    allowUnlimitedSubmissions,
    ratedChallenge,
    actor,
    createdAt,
    updatedAt,
  } = params;

  const placementByUserId = new Map<string, number>();
  for (const winner of placementWinners) {
    const normalizedUserId = normalizeUserId(winner.userId);
    if (!normalizedUserId) {
      continue;
    }

    const previousPlacement = placementByUserId.get(normalizedUserId);
    if (
      previousPlacement === undefined ||
      winner.placement < previousPlacement
    ) {
      placementByUserId.set(normalizedUserId, winner.placement);
    }
  }

  const canonicalEntries = selectCanonicalChallengeResultEntries(
    candidates,
    allowUnlimitedSubmissions,
  );

  const records: ChallengeResultRecord[] = canonicalEntries.map(
    ({ userId, candidate }) => {
      const placement = placementByUserId.get(userId) ?? 0;
      const passedReview = candidate.passedReview || placement > 0;
      const validSubmission = candidate.validSubmission || passedReview;

      return {
        challengeId,
        userId,
        submissionId: candidate.submissionId,
        initialScore: candidate.initialScore,
        finalScore: candidate.finalScore,
        placement,
        rated: ratedChallenge && passedReview,
        passedReview,
        validSubmission,
        ratingOrder: null,
        createdAt,
        createdBy: actor,
        updatedAt,
        updatedBy: actor,
      };
    },
  );

  const ratedRecords = [...records]
    .filter((record) => record.rated)
    .sort(compareChallengeResultRecordsForRanking);

  ratedRecords.forEach((record, index) => {
    record.ratingOrder = index + 1;
  });

  return records.sort((left, right) => left.userId.localeCompare(right.userId));
}

/**
 * Choose one canonical submission candidate per member.
 * @param candidates Per-submission challenge result candidates.
 * @param allowUnlimitedSubmissions Whether multiple submissions per member are allowed.
 * @returns Canonical candidate per normalized member id.
 * @throws Never.
 */
function selectCanonicalChallengeResultEntries(
  candidates: ChallengeResultCandidate[],
  allowUnlimitedSubmissions: boolean,
): CanonicalChallengeResultEntry[] {
  const candidatesByUserId = new Map<string, ChallengeResultCandidate[]>();

  for (const candidate of candidates) {
    const userId = normalizeUserId(candidate.memberId);
    if (!userId) {
      continue;
    }

    const bucket = candidatesByUserId.get(userId) ?? [];
    bucket.push(candidate);
    candidatesByUserId.set(userId, bucket);
  }

  const entries: CanonicalChallengeResultEntry[] = [];

  for (const [userId, userCandidates] of candidatesByUserId.entries()) {
    if (!userCandidates.length) {
      continue;
    }

    const sortedCandidates = [...userCandidates].sort(
      allowUnlimitedSubmissions
        ? compareUnlimitedSubmissionCandidates
        : compareLimitedSubmissionCandidates,
    );

    entries.push({
      userId,
      candidate: sortedCandidates[0],
    });
  }

  return entries;
}

/**
 * Compare limited-submission candidates where the latest reviewed submission
 * should define the member outcome.
 * @param left First candidate.
 * @param right Second candidate.
 * @returns Sort order with the preferred candidate first.
 * @throws Never.
 */
function compareLimitedSubmissionCandidates(
  left: ChallengeResultCandidate,
  right: ChallengeResultCandidate,
): number {
  if (left.isLatest !== right.isLatest) {
    return left.isLatest ? -1 : 1;
  }

  const submittedDateDiff =
    getTimestamp(right.submittedDate) - getTimestamp(left.submittedDate);
  if (submittedDateDiff !== 0) {
    return submittedDateDiff;
  }

  const createdAtDiff =
    getTimestamp(right.createdAt) - getTimestamp(left.createdAt);
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  const updatedAtDiff =
    getTimestamp(right.updatedAt) - getTimestamp(left.updatedAt);
  if (updatedAtDiff !== 0) {
    return updatedAtDiff;
  }

  return right.submissionId.localeCompare(left.submissionId);
}

/**
 * Compare unlimited-submission candidates where the member's strongest valid
 * reviewed outcome should define the final row.
 * @param left First candidate.
 * @param right Second candidate.
 * @returns Sort order with the preferred candidate first.
 * @throws Never.
 */
function compareUnlimitedSubmissionCandidates(
  left: ChallengeResultCandidate,
  right: ChallengeResultCandidate,
): number {
  if (left.passedReview !== right.passedReview) {
    return left.passedReview ? -1 : 1;
  }

  if (left.validSubmission !== right.validSubmission) {
    return left.validSubmission ? -1 : 1;
  }

  if (right.finalScore !== left.finalScore) {
    return right.finalScore - left.finalScore;
  }

  if (right.initialScore !== left.initialScore) {
    return right.initialScore - left.initialScore;
  }

  const submittedDateDiff =
    getTimestamp(left.submittedDate) - getTimestamp(right.submittedDate);
  if (submittedDateDiff !== 0) {
    return submittedDateDiff;
  }

  const createdAtDiff =
    getTimestamp(left.createdAt) - getTimestamp(right.createdAt);
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  const updatedAtDiff =
    getTimestamp(left.updatedAt) - getTimestamp(right.updatedAt);
  if (updatedAtDiff !== 0) {
    return updatedAtDiff;
  }

  return left.submissionId.localeCompare(right.submissionId);
}

/**
 * Rank final challenge result rows for rating-order persistence.
 * @param left First row.
 * @param right Second row.
 * @returns Sort order with the higher-ranked row first.
 * @throws Never.
 */
function compareChallengeResultRecordsForRanking(
  left: ChallengeResultRecord,
  right: ChallengeResultRecord,
): number {
  if (right.finalScore !== left.finalScore) {
    return right.finalScore - left.finalScore;
  }

  if (right.initialScore !== left.initialScore) {
    return right.initialScore - left.initialScore;
  }

  const createdAtDiff =
    getTimestamp(left.createdAt) - getTimestamp(right.createdAt);
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  return left.submissionId.localeCompare(right.submissionId);
}

/**
 * Normalize challenge-result user ids into stable string keys.
 * @param value User id value from challenge or review data.
 * @returns Trimmed user id string or `null` when the value is blank.
 * @throws Never.
 */
function normalizeUserId(
  value: number | string | null | undefined,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length ? normalized : null;
}

/**
 * Convert an optional date to a sortable numeric timestamp.
 * @param value Date to normalize.
 * @returns Finite timestamp or `0` when absent/invalid.
 * @throws Never.
 */
function getTimestamp(value: Date | null): number {
  if (!value) {
    return 0;
  }

  const timestamp = value.getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}
