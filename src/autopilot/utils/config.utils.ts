import { AutopilotOperator } from '../interfaces/autopilot.interface';

export function getNormalizedStringArray(
  source: unknown,
  fallback: string[],
): string[] {
  if (Array.isArray(source)) {
    const normalized = source
      .map((item) => (typeof item === 'string' ? item.trim() : String(item)))
      .filter((item) => item.length > 0);

    if (normalized.length > 0) {
      return normalized;
    }
  }

  if (typeof source === 'string' && source.length > 0) {
    const normalized = source
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    if (normalized.length > 0) {
      return normalized;
    }
  }

  return fallback;
}

export function isActiveStatus(status?: string): boolean {
  return (status ?? '').toUpperCase() === 'ACTIVE';
}

export function hasTransitionedToActive(
  previousStatus?: string | null,
  currentStatus?: string | null,
): boolean {
  const wasActive = isActiveStatus(previousStatus ?? undefined);
  const isActive = isActiveStatus(currentStatus ?? undefined);

  return !wasActive && isActive;
}

export function parseOperator(operator?: AutopilotOperator | string): string {
  return typeof operator === 'string'
    ? operator
    : (operator ?? AutopilotOperator.SYSTEM);
}
