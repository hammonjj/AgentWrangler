import { describe, expect, it } from 'vitest';
import { assessDelegation, delegationOffer, type DelegationContext } from '../src/shared/delegationIntent';

const context: DelegationContext = { repoRoot: '/Users/test/proj', policyVersion: 'default', verificationCommands: [] };

describe('deterministic conversation intent', () => {
  it.each([
    ['Explain how to implement a cache with integration tests.', 'continue', 'conversation'],
    ['Can you review the migration and its tests?', 'continue', 'conversation'],
    ['Discuss a background worker for the import service.', 'continue', 'conversation'],
    ['Should we build a new importer with tests?', 'continue', 'conversation'],
    ['Fix a typo in the importer and run tests.', 'continue', 'interactive'],
    ['Add a tooltip to the save button and update tests.', 'continue', 'interactive'],
    ['Add a null check to the parser and test it.', 'continue', 'interactive'],
    ['Add one-line validation to the parser and test it.', 'continue', 'interactive'],
    ['Implement caching for the service with tests, but keep working here.', 'continue', 'interactive'],
    ['Implement caching for the service with tests. Do not delegate.', 'continue', 'interactive'],
    ['Maybe migrate the storage layer across the service with tests.', 'continue', 'ambiguous'],
    ['Implement this approach for the parser and add integration tests.', 'continue', 'ambiguous'],
    ['Make it better.', 'continue', 'ambiguous'],
    ['Fix the parser.', 'continue', 'ambiguous'],
    ['Implement a bounded retry policy for the import service and add regression tests.', 'offer', 'bounded-work'],
    ['Build the import API and migrate the client across modules with integration tests.', 'offer', 'bounded-work'],
    ['Can you implement issue #123 with regression tests for the empty input case?', 'offer', 'bounded-work'],
    ['Delegate this', 'continue', 'explicit'],
    ['Please hand this off', 'continue', 'explicit'],
    ['Run this as a task', 'continue', 'explicit'],
    ['aw delegate implement the parser', 'continue', 'explicit'],
    ['aw task implement the parser', 'continue', 'explicit'],
  ])('%s → %s (%s)', (request, decision, reason) => {
    expect(assessDelegation(request, context)).toEqual({ decision, reason });
    // The policy and request are the only inputs: there is no provider parameter.
    expect(assessDelegation(request, { ...context })).toEqual(assessDelegation(request, context));
  });

  it('does not offer in a non-git folder or with orchestration unavailable', () => {
    expect(assessDelegation('Implement a bounded retry policy for the importer with tests.')).toEqual({ decision: 'continue', reason: 'unavailable' });
  });

  it('uses independent verification supplied by the repository policy', () => {
    const request = 'Migrate the cache across the import service and its consumers.';
    expect(assessDelegation(request, context).decision).toBe('continue');
    expect(assessDelegation(request, { ...context, verificationCommands: ['test'] }).decision).toBe('offer');
  });

  it('keeps the full objective and explicit criteria in the reviewable handoff', () => {
    const text = 'Implement retries for the importer.\nAcceptance criteria:\n- Retry twice\n- Tests pass';
    expect(delegationOffer('offer1', text, context)).toMatchObject({
      objective: text, repository: context.repoRoot, acceptanceCriteria: ['Retry twice', 'Tests pass'],
    });
  });
});
