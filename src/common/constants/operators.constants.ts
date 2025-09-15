/**
 * Autopilot Operator Constants
 *
 * This file documents the valid operator values used throughout the autopilot system.
 * These operators identify the source or initiator of various autopilot operations.
 */

import { AutopilotOperator } from '../../autopilot/interfaces/autopilot.interface';

/**
 * System operators used by internal autopilot services
 */
export const SYSTEM_OPERATORS = {
  /** General system operations */
  SYSTEM: AutopilotOperator.SYSTEM,

  /** Operations initiated by the scheduler service when executing scheduled phase transitions */
  SYSTEM_SCHEDULER: AutopilotOperator.SYSTEM_SCHEDULER,

  /** Operations initiated when handling new challenge creation events */
  SYSTEM_NEW_CHALLENGE: AutopilotOperator.SYSTEM_NEW_CHALLENGE,

  /** Operations initiated by the recovery service during application bootstrap */
  SYSTEM_RECOVERY: AutopilotOperator.SYSTEM_RECOVERY,

  /** Operations initiated by the sync service during periodic synchronization */
  SYSTEM_SYNC: AutopilotOperator.SYSTEM_SYNC,

  /** Operations initiated when opening next phases in the transition chain */
  SYSTEM_PHASE_CHAIN: AutopilotOperator.SYSTEM_PHASE_CHAIN,
} as const;

/**
 * Administrative operators for manual operations
 */
export const ADMIN_OPERATORS = {
  /** Administrative operations (manual commands, overrides, etc.) */
  ADMIN: AutopilotOperator.ADMIN,
} as const;

/**
 * User operators for external operations
 */
export const USER_OPERATORS = {
  /** Operations initiated by end users */
  USER: AutopilotOperator.USER,
} as const;

/**
 * All valid autopilot operators
 */
export const ALL_OPERATORS = {
  ...SYSTEM_OPERATORS,
  ...ADMIN_OPERATORS,
  ...USER_OPERATORS,
} as const;

/**
 * Operator usage documentation
 */
export const OPERATOR_USAGE = {
  [AutopilotOperator.SYSTEM]: 'General system operations and default fallback',
  [AutopilotOperator.SYSTEM_SCHEDULER]:
    'Scheduled phase transitions executed by the scheduler service',
  [AutopilotOperator.SYSTEM_NEW_CHALLENGE]:
    'Phase scheduling triggered by new challenge creation',
  [AutopilotOperator.SYSTEM_RECOVERY]:
    'Phase processing during application recovery/bootstrap',
  [AutopilotOperator.SYSTEM_SYNC]:
    'Phase synchronization during periodic sync operations',
  [AutopilotOperator.SYSTEM_PHASE_CHAIN]:
    'Opening next phases in the transition chain after phase completion',
  [AutopilotOperator.ADMIN]:
    'Manual administrative operations and command overrides',
  [AutopilotOperator.USER]:
    'Operations initiated by end users through external interfaces',
} as const;
