/**
 * Command constants for the autopilot service
 * These are used in the handleCommand method to process commands
 */
export const AUTOPILOT_COMMANDS = {
  /**
   * Cancels scheduled phase transitions
   * Parameters:
   * - projectId: number (required) - The project ID
   * - phaseId: string (optional) - The specific phase UUID to cancel
   * If not provided, all phases for the project will be canceled
   */
  CANCEL_SCHEDULE: 'cancel_schedule',

  /**
   * Reschedules a phase transition
   * Parameters:
   * - projectId: number (required) - The project ID
   * - phaseId: string (required) - The phase UUID to reschedule
   * - date: string (required) - The new end time in ISO format
   */
  RESCHEDULE_PHASE: 'reschedule_phase',
};
