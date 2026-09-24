import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { describeDetails, describeError } from './errors';

describe('describeDetails', () => {
  it('formats zod issues with their path', () => {
    expect(
      describeDetails([
        { path: ['settings', 'language'], message: 'Invalid language' },
        { path: [], message: 'Script too short' },
      ]),
    ).toEqual(['settings.language: Invalid language', 'Script too short']);
  });

  it('accepts { issues } and { fieldErrors } shapes', () => {
    expect(describeDetails({ issues: [{ path: ['script'], message: 'Required' }] })).toEqual(['script: Required']);
    expect(describeDetails({ fieldErrors: { script: ['Too long'] } })).toEqual(['script: Too long']);
    expect(describeDetails(undefined)).toEqual([]);
  });
});

describe('describeError', () => {
  it('uses a specific title and hint for known codes', () => {
    const described = describeError(new ApiError(402, 'budget_exceeded', 'Daily budget of $20 would be exceeded.'));
    expect(described.title).toBe('Daily budget reached');
    expect(described.message).toContain('Daily budget of $20 would be exceeded.');
  });

  it('handles plain errors and unknown values', () => {
    expect(describeError(new Error('Boom')).message).toBe('Boom');
    expect(describeError('weird').title).toBe('Something went wrong');
  });
});
