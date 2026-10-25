import { describe, expect, it } from 'vitest';
import {
  describeModelSelection,
  parseModelCommand,
  type ModelSelection,
} from '../src/cli/model-command.js';

const current: ModelSelection = { model: 'claude-test', reasoningEffort: 'medium' };

describe('/model parsing', () => {
  it('shows the current selection', () => {
    expect(parseModelCommand('/model', current)).toEqual({ type: 'show' });
    expect(parseModelCommand('  /model  ', current)).toEqual({ type: 'show' });
  });

  it('sets the model and keeps the current effort', () => {
    expect(parseModelCommand('/model claude-next', current)).toEqual({
      type: 'set',
      selection: { model: 'claude-next', reasoningEffort: 'medium' },
    });
  });

  it('sets model and effort, case-insensitively', () => {
    expect(parseModelCommand('/model claude-next HIGH', current)).toEqual({
      type: 'set',
      selection: { model: 'claude-next', reasoningEffort: 'high' },
    });
    expect(parseModelCommand('/model claude-next xhigh', current)).toEqual({
      type: 'set',
      selection: { model: 'claude-next', reasoningEffort: 'xhigh' },
    });
  });

  it('changes only effort with --effort, -e or effort', () => {
    expect(parseModelCommand('/model --effort low', current)).toEqual({
      type: 'set',
      selection: { model: 'claude-test', reasoningEffort: 'low' },
    });
    expect(parseModelCommand('/model -e max', current)).toEqual({
      type: 'set',
      selection: { model: 'claude-test', reasoningEffort: 'max' },
    });
    expect(parseModelCommand('/model effort high', current)).toEqual({
      type: 'set',
      selection: { model: 'claude-test', reasoningEffort: 'high' },
    });
  });

  it('clears the effort override with default/off/none/auto', () => {
    for (const alias of ['default', 'off', 'none', 'auto']) {
      expect(parseModelCommand('/model --effort ' + alias, current)).toEqual({
        type: 'set',
        selection: { model: 'claude-test' },
      });
      expect(parseModelCommand('/model claude-next ' + alias, current)).toEqual({
        type: 'set',
        selection: { model: 'claude-next' },
      });
    }
  });

  it('reports invalid usage instead of throwing', () => {
    for (const line of [
      '/model --effort',
      '/model --effort turbo',
      '/model claude-next turbo',
      '/model claude-next high extra',
      '/model --unknown',
    ]) {
      const parsed = parseModelCommand(line, current);
      expect(parsed.type).toBe('error');
      if (parsed.type === 'error') expect(parsed.message).toContain('Usage: /model');
    }
  });

  it('formats the selection for notices', () => {
    expect(describeModelSelection(current)).toBe('model: claude-test\neffort: medium');
    expect(describeModelSelection({ model: 'm' })).toBe('model: m\neffort: default');
  });
});
