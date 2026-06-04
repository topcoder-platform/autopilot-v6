import { PrizeSetTypeEnum } from '@prisma/client';
import type {
  IChallenge,
  IChallengePrize,
  IChallengePrizeSet,
  IChallengeWinner,
} from '../../challenge/interfaces/challenge.interface';

export interface ChallengePointAward {
  placement: number;
  points: number;
  userId: number;
}

const POINT_PRIZE_TYPE = 'POINT';

/**
 * Returns the normalized prize value type used to detect point-based placement prizes.
 * @param prize Prize row from a challenge placement prize set.
 * @returns Uppercase prize type token.
 * @throws Never. Missing values return an empty string.
 */
function getPrizeType(prize?: IChallengePrize): string {
  return (prize?.type ?? '').trim().toUpperCase();
}

/**
 * Finds the placement prize set for a challenge.
 * @param challenge Challenge snapshot from challenge-api.
 * @returns Placement prize set when present, otherwise undefined.
 * @throws Never.
 */
function getPlacementPrizeSet(
  challenge: IChallenge,
): IChallengePrizeSet | undefined {
  return (challenge.prizeSets ?? []).find(
    (prizeSet) => prizeSet.type === PrizeSetTypeEnum.PLACEMENT,
  );
}

/**
 * Determines whether a challenge has point-based placement prizes.
 * @param challenge Challenge snapshot from challenge-api.
 * @returns True when any placement prize is typed as POINT.
 * @throws Never.
 */
export function hasPointPlacementPrizes(challenge: IChallenge): boolean {
  const placementPrizeSet = getPlacementPrizeSet(challenge);

  return (placementPrizeSet?.prizes ?? []).some(
    (prize) => getPrizeType(prize) === POINT_PRIZE_TYPE,
  );
}

/**
 * Builds member challenge-point awards from placement winners and POINT prizes.
 * @param challenge Challenge snapshot containing placement prize values.
 * @param winners Winner rows to map by placement.
 * @returns Point awards sorted by placement.
 * @throws Never. Invalid, non-placement, missing, and non-positive awards are skipped.
 */
export function buildChallengePointAwards(
  challenge: IChallenge,
  winners: IChallengeWinner[],
): ChallengePointAward[] {
  const placementPrizeSet = getPlacementPrizeSet(challenge);
  const prizes = placementPrizeSet?.prizes ?? [];
  const awardByUserId = new Map<number, ChallengePointAward>();

  for (const winner of winners ?? []) {
    if (
      winner.type !== undefined &&
      winner.type !== PrizeSetTypeEnum.PLACEMENT
    ) {
      continue;
    }

    if (!Number.isFinite(winner.userId) || winner.placement <= 0) {
      continue;
    }

    const prize = prizes[winner.placement - 1];
    if (getPrizeType(prize) !== POINT_PRIZE_TYPE) {
      continue;
    }

    const points = Math.trunc(Number(prize.value));
    if (!Number.isFinite(points) || points <= 0) {
      continue;
    }

    const existingAward = awardByUserId.get(winner.userId);
    if (existingAward && existingAward.placement <= winner.placement) {
      continue;
    }

    awardByUserId.set(winner.userId, {
      userId: winner.userId,
      placement: winner.placement,
      points,
    });
  }

  return Array.from(awardByUserId.values()).sort(
    (awardA, awardB) => awardA.placement - awardB.placement,
  );
}
