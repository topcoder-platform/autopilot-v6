import { selectSubmissionIdsWithinLimit } from './submission-selection.utils';

describe('selectSubmissionIdsWithinLimit', () => {
  const submissions = [
    { id: 'member-1-newest', submissionRank: 1 },
    { id: 'member-1-second', submissionRank: 2 },
    { id: 'member-1-third', submissionRank: 3 },
    { id: 'member-2-newest', submissionRank: 1 },
    { id: 'member-2-second', submissionRank: 2 },
  ];

  it('selects the latest configured number for every member', () => {
    expect(selectSubmissionIdsWithinLimit(submissions, 2)).toEqual([
      'member-1-newest',
      'member-1-second',
      'member-2-newest',
      'member-2-second',
    ]);
  });

  it('selects every submission for an unlimited challenge', () => {
    expect(selectSubmissionIdsWithinLimit(submissions, null)).toEqual(
      submissions.map((submission) => submission.id),
    );
  });

  it('ignores invalid ranks and blank IDs for a finite limit', () => {
    expect(
      selectSubmissionIdsWithinLimit(
        [
          { id: 'valid', submissionRank: 1 },
          { id: 'zero-rank', submissionRank: 0 },
          { id: 'fractional-rank', submissionRank: 1.5 },
          { id: '', submissionRank: 1 },
        ],
        2,
      ),
    ).toEqual(['valid']);
  });
});
