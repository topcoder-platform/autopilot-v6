import type { IChallenge } from '../../challenge/interfaces/challenge.interface';

/**
 * Parse loosely typed challenge metadata values into booleans.
 * @param value Metadata value to normalize.
 * @returns Parsed boolean or `null` when the value is not recognizable.
 * @throws Never.
 */
export function parseMetadataBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(normalized)) {
      return true;
    }
    if (['false', 'no', '0'].includes(normalized)) {
      return false;
    }
    return null;
  }

  if (typeof value === 'number') {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }

  return null;
}

/**
 * Determine whether challenge metadata marks the challenge as rated.
 * @param challenge Challenge snapshot whose metadata should be inspected.
 * @returns `true` only when the metadata explicitly opts into rating.
 * @throws Never. Ambiguous or missing metadata defaults to unrated.
 */
export function isRatedChallenge(
  challenge: Pick<IChallenge, 'metadata'>,
): boolean {
  const metadata = (challenge.metadata ?? {}) as Record<string, unknown>;
  const unrated = parseMetadataBoolean(metadata['unrated']);
  if (unrated === true) {
    return false;
  }

  const rated = parseMetadataBoolean(metadata['rated']);
  if (rated !== null) {
    return rated;
  }

  const isRated = parseMetadataBoolean(metadata['isRated']);
  if (isRated !== null) {
    return isRated;
  }

  if (unrated === false) {
    return true;
  }

  return false;
}

/**
 * Resolve whether challenge metadata allows unlimited contest submissions.
 * @param challenge Challenge snapshot whose metadata should be inspected.
 * @param warn Optional callback used when metadata cannot be interpreted.
 * @returns `true` when metadata explicitly disables the submission cap.
 * @throws Never. Unrecognized metadata falls back to limited submissions.
 */
export function challengeAllowsUnlimitedSubmissions(
  challenge: Pick<IChallenge, 'id' | 'metadata'>,
  warn?: (message: string) => void,
): boolean {
  const metadata = challenge.metadata ?? {};
  const rawValue = metadata['submissionLimit'];

  if (rawValue == null) {
    return false;
  }

  const warnUnrecognized = (value: unknown) => {
    if (!warn) {
      return;
    }

    warn(
      `Unrecognized submissionLimit metadata value ${describeSubmissionLimitValue(
        value,
      )} for challenge ${challenge.id}; defaulting to limited submissions.`,
    );
  };

  let parsed: unknown = rawValue;

  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      warnUnrecognized(rawValue);
      return false;
    }

    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const numericValue = Number(trimmed);
      if (Number.isFinite(numericValue) && numericValue > 0) {
        return false;
      }

      const normalized = trimmed.toLowerCase();
      if (['unlimited', 'false', '0', 'no', 'none'].includes(normalized)) {
        return true;
      }

      warnUnrecognized(trimmed);
      return false;
    }
  }

  if (typeof parsed === 'number') {
    return !(Number.isFinite(parsed) && parsed > 0);
  }

  if (typeof parsed === 'string') {
    const numericValue = Number(parsed);
    if (Number.isFinite(numericValue) && numericValue > 0) {
      return false;
    }

    const normalized = parsed.trim().toLowerCase();
    if (['unlimited', 'false', '0', 'no', 'none'].includes(normalized)) {
      return true;
    }

    warnUnrecognized(parsed);
    return false;
  }

  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;

    const unlimited = parseMetadataBoolean(record.unlimited);
    if (unlimited === true) {
      return true;
    }

    const candidates = [
      record.count,
      record.max,
      record.maximum,
      record.limitCount,
      record.value,
    ];

    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null) {
        continue;
      }

      const numericValue = Number(candidate);
      if (Number.isFinite(numericValue) && numericValue > 0) {
        return false;
      }
    }

    const limitFlag = parseMetadataBoolean(record.limit);
    if (limitFlag === true) {
      return false;
    }
    if (limitFlag === false) {
      return true;
    }

    warnUnrecognized(record);
    return false;
  }

  warnUnrecognized(parsed);
  return false;
}

/**
 * Format raw submission-limit metadata for warnings.
 * @param value Metadata value to describe.
 * @returns Human-readable representation for log output.
 * @throws Never.
 */
function describeSubmissionLimitValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return value.trim().length ? `"${value}"` : '(empty string)';
  }

  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return 'NaN';
    }
    return `${value}`;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable value]';
  }
}
