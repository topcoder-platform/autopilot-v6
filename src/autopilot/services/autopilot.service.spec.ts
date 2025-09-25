import { AutopilotService } from './autopilot.service';
import { SchedulerService } from './scheduler.service';
import { ChallengeApiService } from '../../challenge/challenge-api.service';
import { PhaseReviewService } from './phase-review.service';
import { ReviewAssignmentService } from './review-assignment.service';
import { SubmissionAggregatePayload } from '../interfaces/autopilot.interface';
import {
  IChallenge,
  IPhase,
} from '../../challenge/interfaces/challenge.interface';

describe('AutopilotService - handleSubmissionNotificationAggregate', () => {
  const isoNow = new Date().toISOString();

  const createPhase = (overrides: Partial<IPhase> = {}): IPhase => ({
    id: 'phase-1',
    phaseId: 'phase-1',
    name: 'Iterative Review',
    description: null,
    isOpen: false,
    duration: 0,
    scheduledStartDate: isoNow,
    scheduledEndDate: isoNow,
    actualStartDate: null,
    actualEndDate: null,
    predecessor: null,
    constraints: [],
    ...overrides,
  });

  const createChallenge = (
    overrides: Partial<IChallenge> = {},
  ): IChallenge => ({
    id: 'challenge-123',
    name: 'Test Challenge',
    description: null,
    descriptionFormat: 'markdown',
    projectId: 123,
    typeId: 'type-id',
    trackId: 'track-id',
    timelineTemplateId: 'template-id',
    currentPhaseNames: [],
    tags: [],
    groups: [],
    submissionStartDate: isoNow,
    submissionEndDate: isoNow,
    registrationStartDate: isoNow,
    registrationEndDate: isoNow,
    startDate: isoNow,
    endDate: null,
    legacyId: null,
    status: 'ACTIVE',
    createdBy: 'tester',
    updatedBy: 'tester',
    metadata: [],
    phases: [createPhase()],
    reviewers: [],
    winners: [],
    discussions: [],
    events: [],
    prizeSets: [],
    terms: [],
    skills: [],
    attachments: [],
    track: 'Development',
    type: 'First2Finish',
    legacy: {},
    task: {},
    created: isoNow,
    updated: isoNow,
    overview: {},
    numOfSubmissions: 0,
    numOfCheckpointSubmissions: 0,
    numOfRegistrants: 0,
    ...overrides,
  });

  const createPayload = (
    overrides: Partial<SubmissionAggregatePayload> = {},
  ): SubmissionAggregatePayload => ({
    resource: 'submission',
    id: 'submission-1',
    originalTopic: 'submission.notification.create',
    v5ChallengeId: 'challenge-123',
    ...overrides,
  });

  let schedulerService: Partial<SchedulerService>;
  let challengeApiService: {
    getChallengeById: jest.Mock;
    advancePhase: jest.Mock;
  };
  let autopilotService: AutopilotService;

  beforeEach(() => {
    schedulerService = {
      setPhaseChainCallback: jest.fn(),
      schedulePhaseTransition: jest.fn().mockResolvedValue('job-id'),
      cancelScheduledTransition: jest.fn().mockResolvedValue(true),
      getScheduledTransition: jest.fn(),
    };

    challengeApiService = {
      getChallengeById: jest.fn(),
      advancePhase: jest.fn(),
    };

    autopilotService = new AutopilotService(
      schedulerService as SchedulerService,
      challengeApiService as unknown as ChallengeApiService,
      {} as PhaseReviewService,
      {} as ReviewAssignmentService,
    );

    jest.clearAllMocks();
  });

  it('ignores messages that are not submission.create aggregates', async () => {
    await autopilotService.handleSubmissionNotificationAggregate(
      createPayload({ originalTopic: 'submission.notification.update' }),
    );

    expect(challengeApiService.getChallengeById).not.toHaveBeenCalled();
    expect(challengeApiService.advancePhase).not.toHaveBeenCalled();
  });

  it('ignores messages without a v5 challenge id', async () => {
    await autopilotService.handleSubmissionNotificationAggregate(
      createPayload({ v5ChallengeId: undefined }),
    );

    expect(challengeApiService.getChallengeById).not.toHaveBeenCalled();
  });

  it('opens iterative review phase for First2Finish challenge', async () => {
    const iterativeReviewPhase = createPhase({ id: 'iterative-phase' });
    challengeApiService.getChallengeById.mockResolvedValue(
      createChallenge({ phases: [iterativeReviewPhase] }),
    );
    challengeApiService.advancePhase.mockResolvedValue({
      success: true,
      message: 'opened',
    });

    await autopilotService.handleSubmissionNotificationAggregate(
      createPayload({ id: 'submission-123' }),
    );

    expect(challengeApiService.getChallengeById).toHaveBeenCalledWith(
      'challenge-123',
    );
    expect(challengeApiService.advancePhase).toHaveBeenCalledWith(
      'challenge-123',
      'iterative-phase',
      'open',
    );
  });

  it('skips non-First2Finish challenges', async () => {
    challengeApiService.getChallengeById.mockResolvedValue(
      createChallenge({ type: 'Design Challenge' }),
    );

    await autopilotService.handleSubmissionNotificationAggregate(
      createPayload(),
    );

    expect(challengeApiService.advancePhase).not.toHaveBeenCalled();
  });

  it('skips when iterative review phase is already open', async () => {
    const iterativeReviewPhase = createPhase({ isOpen: true });
    challengeApiService.getChallengeById.mockResolvedValue(
      createChallenge({ phases: [iterativeReviewPhase] }),
    );

    await autopilotService.handleSubmissionNotificationAggregate(
      createPayload(),
    );

    expect(challengeApiService.advancePhase).not.toHaveBeenCalled();
  });

  it('skips when iterative review phase is not present', async () => {
    challengeApiService.getChallengeById.mockResolvedValue(
      createChallenge({
        phases: [createPhase({ name: 'Submission', id: 'submission-phase' })],
      }),
    );

    await autopilotService.handleSubmissionNotificationAggregate(
      createPayload(),
    );

    expect(challengeApiService.advancePhase).not.toHaveBeenCalled();
  });
});
