import { describe, expect, it } from 'vitest';
import { parseQuestions, permissionResult, planResult, questionResult } from '../src/claude/runner/askResults';
import type { RawAsk } from '../src/shared/sessionProtocol';

const bash: RawAsk = { requestId: 'r1', toolName: 'Bash', input: { command: 'npm test' }, suggestions: [{ rule: 'x' }] };
const question: RawAsk = {
  requestId: 'r2',
  toolName: 'AskUserQuestion',
  input: { questions: [{ question: 'Which?', header: 'H', options: [{ label: 'A', description: 'a' }, { label: '' }] }] },
};
const plan: RawAsk = { requestId: 'r3', toolName: 'ExitPlanMode', input: { plan: 'Do it' } };

describe('ask results', () => {
  it('builds the same canUseTool results RunnerView sends', () => {
    expect(permissionResult(bash, 'allow')).toEqual({ behavior: 'allow', updatedInput: bash.input });
    expect(permissionResult(bash, 'always')).toEqual({ behavior: 'allow', updatedInput: bash.input, updatedPermissions: bash.suggestions });
    expect(permissionResult(bash, 'deny')).toEqual({ behavior: 'deny', message: 'Denied from Agent Wrangler.' });
    expect(questionResult(question, { 'Which?': 'A' })).toEqual({
      behavior: 'allow',
      updatedInput: { ...question.input, answers: { 'Which?': 'A' } },
    });
    expect(planResult(plan, true)).toEqual({ behavior: 'allow', updatedInput: plan.input });
    expect(planResult(plan, false, ' ')).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/Keep planning/) });
  });

  it('parses AskUserQuestion input defensively, dropping options with no label', () => {
    expect(parseQuestions(question.input.questions)).toEqual([
      { question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'A', description: 'a' }] },
    ]);
    expect(parseQuestions('nope')).toEqual([]);
  });
});
