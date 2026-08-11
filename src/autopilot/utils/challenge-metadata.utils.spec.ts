import { resolveReviewSubmissionLimit } from './challenge-metadata.utils';

describe('resolveReviewSubmissionLimit', () => {
  const buildChallenge = (
    track: string,
    submissionLimit?: unknown,
  ): Parameters<typeof resolveReviewSubmissionLimit>[0] => ({
    id: 'challenge-1',
    track,
    metadata:
      submissionLimit === undefined
        ? {}
        : ({ submissionLimit } as unknown as Record<string, string>),
  });

  it.each([1, 2, 3])(
    'returns the configured Design submission count %s',
    (count) => {
      const challenge = buildChallenge(
        'Design',
        JSON.stringify({
          count: String(count),
          limit: 'true',
          unlimited: 'false',
        }),
      );

      expect(resolveReviewSubmissionLimit(challenge)).toBe(count);
    },
  );

  it('treats missing Design metadata as unlimited', () => {
    expect(resolveReviewSubmissionLimit(buildChallenge('Design'))).toBeNull();
  });

  it('returns unlimited for explicit Design unlimited metadata', () => {
    const challenge = buildChallenge(
      'Design',
      JSON.stringify({
        count: '3',
        limit: 'false',
        unlimited: 'true',
      }),
    );

    expect(resolveReviewSubmissionLimit(challenge)).toBeNull();
  });

  it.each([
    ['Development', undefined],
    [
      'Development',
      JSON.stringify({ count: '3', limit: 'true', unlimited: 'false' }),
    ],
    [
      'Development',
      JSON.stringify({ count: '', limit: 'false', unlimited: 'true' }),
    ],
    ['Data Science', undefined],
  ])('always returns one for non-Design track %s', (track, metadata) => {
    expect(resolveReviewSubmissionLimit(buildChallenge(track, metadata))).toBe(
      1,
    );
  });

  it.each([
    ['malformed JSON', '{"limit": }'],
    ['missing limited count', JSON.stringify({ limit: true })],
    [
      'contradictory flags',
      JSON.stringify({ count: '2', limit: true, unlimited: true }),
    ],
    ['boolean true', true],
  ])('falls back to one and warns for %s', (_description, metadata) => {
    const warn = jest.fn();

    expect(
      resolveReviewSubmissionLimit(buildChallenge('Design', metadata), warn),
    ).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('defaulting to the latest submission'),
    );
  });
});
