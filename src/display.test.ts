import { describe, expect, test } from 'bun:test';

import { displayClaudeEvent, TranscriptRenderer } from './display.ts';

const plain = { verbose: false, debug: false };
const verbose = { verbose: true, debug: false };
const debug = { verbose: false, debug: true };

function assistant(content: unknown[], model = 'test-model') {
  return { type: 'assistant', message: { type: 'message', model, content } };
}

function user(content: unknown[]) {
  return { type: 'user', message: { content } };
}

function thinking(text: string) {
  return assistant([ { type: 'thinking', thinking: text } ]);
}

function toolUse(name: string, input: object, id = 'toolu_1') {
  return { type: 'tool_use', id, name, input };
}

function toolResult(toolUseId: string, content: unknown) {
  return user([ { type: 'tool_result', tool_use_id: toolUseId, content } ]);
}

describe('truncation', () => {
  test('leaves a block at the limit untouched', () => {
    const lines = Array.from({ length: 16 }, (_, i) => `line${i + 1}`);

    const rendered = displayClaudeEvent(thinking(lines.join('\n')), plain);

    expect(rendered).not.toContain('truncated');
    expect(rendered.split('\n')).toHaveLength(18); // header + 16 lines + trailing
  });

  test('never renders more lines than it stands in for', () => {
    const lines = Array.from({ length: 17 }, (_, i) => `line${i + 1}`);

    const rendered = displayClaudeEvent(thinking(lines.join('\n')), plain);
    const body = rendered.split('\n').filter(l => l.startsWith('| '));

    expect(body).toHaveLength(16);
    expect(rendered).toContain('... [2 lines truncated] ...');
  });

  test('pluralizes the marker correctly', () => {
    const lines = Array.from({ length: 18 }, (_, i) => `line${i + 1}`);

    expect(displayClaudeEvent(thinking(lines.join('\n')), plain))
      .toContain('... [3 lines truncated] ...');
  });

  test('keeps the head and the tail, dropping the middle', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);

    const rendered = displayClaudeEvent(thinking(lines.join('\n')), plain);

    expect(rendered).toContain('| line1\n');
    expect(rendered).toContain('| line40\n');
    expect(rendered).not.toContain('| line20\n');
  });

  test('does not truncate assistant prose', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);

    const rendered = displayClaudeEvent(assistant([ { type: 'text', text: lines.join('\n') } ]), plain);

    expect(rendered).not.toContain('truncated');
    expect(rendered).toContain('| line50\n');
  });

  test('keeps blank lines inside an Agent prompt', () => {
    const event = assistant([
      toolUse('Agent', { description: 'go', prompt: 'a\n\nb' }),
    ]);

    expect(displayClaudeEvent(event, plain)).toBe('• Agent\n| go\n| a\n| \n| b\n');
  });
});

describe('single-block rendering', () => {
  test('renders assistant text in full', () => {
    expect(displayClaudeEvent(assistant([ { type: 'text', text: 'hello\nworld' } ]), plain))
      .toBe('• Assistant\n| hello\n| world\n');
  });

  test('renders synthetic assistant text under its own header', () => {
    const event = assistant([ { type: 'text', text: 'preloaded' } ], '<synthetic>');

    expect(displayClaudeEvent(event, plain)).toBe('• Synthetic\n| preloaded\n');
  });

  test('renders a Bash call with its description', () => {
    const event = assistant([ toolUse('Bash', { command: 'ls -la', description: 'List' }) ]);

    expect(displayClaudeEvent(event, plain)).toBe('• Bash\n| List\n| ls -la\n');
  });

  test('omits the description line when there is none', () => {
    const event = assistant([ toolUse('Bash', { command: 'ls -la' }) ]);

    expect(displayClaudeEvent(event, plain)).toBe('• Bash\n| ls -la\n');
  });

  test('renders a Read call as its path', () => {
    expect(displayClaudeEvent(assistant([ toolUse('Read', { file_path: 'a.txt' }) ]), plain))
      .toBe('• Read\n| a.txt\n');
  });

  test('renders a TaskUpdate status change', () => {
    const event = assistant([ toolUse('TaskUpdate', { taskId: '2', status: 'completed' }) ]);

    expect(displayClaudeEvent(event, plain)).toBe('• Task Update\n| 2: completed\n');
  });

  test('renders a partial TaskUpdate with no status', () => {
    // Measured 2026-07-26: 6 real TaskUpdate calls in the local corpus carry
    // { taskId, addBlockedBy } with no status. isTaskUpdateBlock used to
    // require status, so every one of them fell through to the generic Tool
    // catch-all instead of its own rule.
    const event = assistant([ toolUse('TaskUpdate', { taskId: '3', addBlockedBy: [ '2' ] }) ]);

    expect(displayClaudeEvent(event, plain)).toBe('• Task Update\n| 3\n| Blocked By 2\n');
  });

  test('renders a TaskUpdate description update', () => {
    const event = assistant([ toolUse('TaskUpdate', { taskId: '5', description: 'do the thing' }) ]);

    expect(displayClaudeEvent(event, plain)).toBe('• Task Update\n| 5\n| do the thing\n');
  });

  test('renders a bare TaskUpdate carrying only taskId', () => {
    const event = assistant([ toolUse('TaskUpdate', { taskId: '9' }) ]);

    expect(displayClaudeEvent(event, plain)).toBe('• Task Update\n| 9\n');
  });

  test('renders a user text block', () => {
    expect(displayClaudeEvent(user([ { type: 'text', text: 'hi' } ]), plain)).toBe('• User\n| hi\n');
  });

  test('renders a user string message', () => {
    expect(displayClaudeEvent({ type: 'user', message: { content: 'hi' } }, plain))
      .toBe('• User\n| hi\n');
  });

  test('renders thinking that carries both text and a signature', () => {
    // Measured 2026-07-26: 87 such blocks in the local corpus. The guard used
    // to require an absent signature, so every one of them rendered as nothing.
    const event = assistant([ { type: 'thinking', thinking: 'hm', signature: 'sig' } ]);

    expect(displayClaudeEvent(event, plain)).toBe('• Thinking\n| hm\n');
  });

  test('renders encrypted thinking as a header, and only when verbose', () => {
    const event = assistant([ { type: 'thinking', thinking: '', signature: 'sig' } ]);

    expect(displayClaudeEvent(event, plain)).toBe('');
    expect(displayClaudeEvent(event, verbose)).toBe('• Encrypted Thinking\n');
  });
});

describe('per-content-block dispatch', () => {
  test('renders every block of a record that mixes prose with a tool call', () => {
    // Measured 2026-07-26: 11 such records in the local corpus, all in subagent
    // transcripts or non-Opus models. Per-event dispatch rendered none of them.
    const event = assistant([
      { type: 'thinking', thinking: 'plan' },
      { type: 'text', text: 'Running it.' },
      toolUse('Bash', { command: 'ls' }),
    ]);

    expect(displayClaudeEvent(event, plain))
      .toBe('• Thinking\n| plan\n• Assistant\n| Running it.\n• Bash\n| ls\n');
  });

  test('renders two tool calls in one record as two entries', () => {
    const event = assistant([
      toolUse('Bash', { command: 'ls' }, 'toolu_a'),
      toolUse('Bash', { command: 'pwd' }, 'toolu_b'),
    ]);

    expect(displayClaudeEvent(event, plain)).toBe('• Bash\n| ls\n• Bash\n| pwd\n');
  });

  test('renders a mix of two different tools', () => {
    const event = assistant([
      toolUse('Read', { file_path: 'a.txt' }, 'toolu_a'),
      toolUse('Grep', { pattern: 'x', path: 'src' }, 'toolu_b'),
    ]);

    expect(displayClaudeEvent(event, plain)).toBe('• Read\n| a.txt\n• Grep\n| x\n| in src\n');
  });

  test('renders the blocks it knows and skips the ones it does not', () => {
    const event = assistant([ { type: 'text', text: 'hi' }, { type: 'wat', payload: 1 } ]);

    expect(displayClaudeEvent(event, plain)).toBe('• Assistant\n| hi\n');
    expect(displayClaudeEvent(event, verbose))
      .toBe('• Assistant\n| hi\n{"type":"wat","payload":1}\n');
  });

  test('falls back to the whole record when no block is recognized', () => {
    // Keeping the envelope is the point: a per-block dump would lose the model.
    const event = assistant([ { type: 'wat' } ]);

    expect(displayClaudeEvent(event, plain)).toBe('');
    expect(displayClaudeEvent(event, verbose)).toBe(`${JSON.stringify(event)}\n`);
  });

  test('surfaces a mid-turn model fallback', () => {
    const event = assistant([
      { type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: 'claude-opus-4-8' } },
    ]);

    expect(displayClaudeEvent(event, plain))
      .toBe('• Model Fallback\n| claude-fable-5 → claude-opus-4-8\n');
  });

  test('renders images, which used to match nothing at all', () => {
    const source = { type: 'base64', media_type: 'image/png', data: 'AAAA' };

    expect(displayClaudeEvent(user([ { type: 'image', source } ]), plain))
      .toBe('• Image\n| image/png\n');
    expect(displayClaudeEvent(toolResult('toolu_x', [ { type: 'image', source } ]), plain))
      .toBe('> [image/png]\n');
  });
});

describe('tool result prefixes', () => {
  test('prefixes every line of a string result with >', () => {
    expect(displayClaudeEvent(toolResult('toolu_x', 'a\nb\nc'), plain)).toBe('> a\n> b\n> c\n');
  });

  test('prefixes every line of a text-block result with >', () => {
    const event = toolResult('toolu_x', [ { type: 'text', text: 'a\nb' } ]);

    expect(displayClaudeEvent(event, plain)).toBe('> a\n> b\n');
  });

  test('never mixes > and | in one result', () => {
    const rendered = displayClaudeEvent(toolResult('toolu_x', 'a\nb'), plain);

    expect(rendered.split('\n').filter(Boolean).every(l => l.startsWith('> '))).toBe(true);
  });
});

describe('tool_use to tool_result pairing', () => {
  test('collapses a Read result to a line count, and expands it when verbose', () => {
    const call = assistant([ toolUse('Read', { file_path: 'a.txt' }, 'toolu_3') ]);
    const result = toolResult('toolu_3', '1\ta\n2\tb\n');

    const renderer = new TranscriptRenderer(plain);
    renderer.display(call); // Teaches the renderer which tool the id belongs to.
    expect(renderer.display(result)).toBe('> [3 lines]\n');

    const loud = new TranscriptRenderer(verbose);
    loud.display(call);
    expect(loud.display(result)).toContain('1\ta');
  });

  test('collapses a Read result delivered as text blocks', () => {
    const renderer = new TranscriptRenderer(plain);
    renderer.display(assistant([ toolUse('Read', { file_path: 'a.txt' }, 'toolu_4') ]));

    const result = toolResult('toolu_4', [ { type: 'text', text: 'a\nb' } ]);

    expect(renderer.display(result)).toBe('> [2 lines]\n');
  });

  test('learns the pairing from a record that also carries prose', () => {
    // The old pairing guard demanded that *every* block be a tool_use, so a
    // mixed record taught the renderer nothing.
    const renderer = new TranscriptRenderer(plain);
    renderer.display(assistant([
      { type: 'text', text: 'reading' },
      toolUse('Read', { file_path: 'a.txt' }, 'toolu_5'),
    ]));

    expect(renderer.display(toolResult('toolu_5', 'x\ny'))).toBe('> [2 lines]\n');
  });

  test('pairs a preloaded synthetic Read too', () => {
    const renderer = new TranscriptRenderer(plain);
    renderer.display(assistant([ toolUse('Read', { file_path: 'd.txt' }, 'toolu_s1') ], '<synthetic>'));

    expect(renderer.display(toolResult('toolu_s1', 'x\ny\nz\nw'))).toBe('> [4 lines]\n');
  });

  test('prints a non-Read result in full even when paired', () => {
    const renderer = new TranscriptRenderer(plain);
    renderer.display(assistant([ toolUse('Bash', { command: 'echo hi' }, 'toolu_b1') ]));

    expect(renderer.display(toolResult('toolu_b1', 'hi'))).toBe('> hi\n');
  });

  test('prints an unpaired result in full', () => {
    expect(new TranscriptRenderer(plain).display(toolResult('toolu_missing', 'a\nb')))
      .toBe('> a\n> b\n');
  });

  test('forgets a pairing once its result has arrived', () => {
    const renderer = new TranscriptRenderer(plain);
    renderer.display(assistant([ toolUse('Read', { file_path: 'a.txt' }, 'toolu_6') ]));

    expect(renderer.display(toolResult('toolu_6', 'x\ny'))).toBe('> [2 lines]\n');
    expect(renderer.display(toolResult('toolu_6', 'x\ny'))).toBe('> x\n> y\n');
  });

  test('two renderers do not share pairings', () => {
    const one = new TranscriptRenderer(plain);
    const two = new TranscriptRenderer(plain);
    one.display(assistant([ toolUse('Read', { file_path: 'a.txt' }, 'toolu_7') ]));

    expect(one.display(toolResult('toolu_7', 'x\ny'))).toBe('> [2 lines]\n');
    expect(two.display(toolResult('toolu_7', 'x\ny'))).toBe('> x\n> y\n');
  });

  test('reset() drops outstanding pairings', () => {
    const renderer = new TranscriptRenderer(plain);
    renderer.display(assistant([ toolUse('Read', { file_path: 'a.txt' }, 'toolu_8') ]));
    renderer.reset();

    expect(renderer.display(toolResult('toolu_8', 'x\ny'))).toBe('> x\n> y\n');
  });

  test('displayClaudeEvent keeps no pairing memory', () => {
    const call = assistant([ toolUse('Read', { file_path: 'a.txt' }, 'toolu_9') ]);
    displayClaudeEvent(call, plain);

    expect(displayClaudeEvent(toolResult('toolu_9', 'x\ny'), plain)).toBe('> x\n> y\n');
  });
});

describe('grouping a result with its call', () => {
  test('does not tag a result when only one call is outstanding', () => {
    // The overwhelmingly common case: nothing changes from before grouping.
    const renderer = new TranscriptRenderer(plain);
    renderer.display(assistant([ toolUse('Bash', { command: 'ls' }, 'toolu_g1') ]));

    expect(renderer.display(toolResult('toolu_g1', 'a\nb'))).toBe('> a\n> b\n');
  });

  test('tags each result by tool name once more than one call is outstanding', () => {
    const renderer = new TranscriptRenderer(plain);
    renderer.display(assistant([
      toolUse('Bash', { command: 'ls' }, 'toolu_g2'),
      toolUse('Grep', { pattern: 'x' }, 'toolu_g3'),
    ]));

    const results = user([
      { type: 'tool_result', tool_use_id: 'toolu_g2', content: 'a' },
      { type: 'tool_result', tool_use_id: 'toolu_g3', content: 'b' },
    ]);

    expect(renderer.display(results)).toBe('> [Bash] a\n> [Grep] b\n');
  });

  test('the tag lands on the first line only, so a multi-line result gains no lines', () => {
    const renderer = new TranscriptRenderer(plain);
    renderer.display(assistant([
      toolUse('Bash', { command: 'ls' }, 'toolu_g4'),
      toolUse('Bash', { command: 'pwd' }, 'toolu_g5'),
    ]));

    expect(renderer.display(toolResult('toolu_g4', 'a\nb\nc'))).toBe('> [Bash] a\n> b\n> c\n');
  });

  test('tags a collapsed Read result too', () => {
    const renderer = new TranscriptRenderer(plain);
    renderer.display(assistant([
      toolUse('Read', { file_path: 'a.txt' }, 'toolu_g6'),
      toolUse('Bash', { command: 'ls' }, 'toolu_g7'),
    ]));

    expect(renderer.display(toolResult('toolu_g6', '1\ta\n2\tb\n'))).toBe('> [Read] [3 lines]\n');
  });

  test('tags an image result', () => {
    const renderer = new TranscriptRenderer(plain);
    renderer.display(assistant([
      toolUse('Bash', { command: 'ls' }, 'toolu_g8'),
      toolUse('Bash', { command: 'pwd' }, 'toolu_g9'),
    ]));
    const source = { type: 'base64', media_type: 'image/png', data: 'AAAA' };

    expect(renderer.display(toolResult('toolu_g8', [ { type: 'image', source } ])))
      .toBe('> [Bash] [image/png]\n');
  });

  test('tags a verbose Tool Reference result too', () => {
    const renderer = new TranscriptRenderer(verbose);
    renderer.display(assistant([
      toolUse('ToolSearch', { query: 'q' }, 'toolu_g10'),
      toolUse('Bash', { command: 'ls' }, 'toolu_g11'),
    ]));

    const reference = user([
      { type: 'tool_result', tool_use_id: 'toolu_g10', content: [ { type: 'tool_reference', tool_name: 'Read' } ] },
    ]);

    expect(renderer.display(reference)).toBe('• Tool Reference [ToolSearch]\n| Read\n');
  });

  test('a never-answered call keeps a later result tagged until reset', () => {
    // A call the stream never answers lingers in the pairing table (measured:
    // 1 in 1 498 corpus calls). Erring toward a tag when in doubt is safer
    // than silently dropping a real ambiguity.
    const renderer = new TranscriptRenderer(plain);
    renderer.display(assistant([ toolUse('Bash', { command: 'ls -la' }, 'toolu_orphan') ]));
    renderer.display(assistant([ toolUse('Bash', { command: 'pwd' }, 'toolu_g12') ]));

    expect(renderer.display(toolResult('toolu_g12', 'ok'))).toBe('> [Bash] ok\n');

    renderer.reset();
    renderer.display(assistant([ toolUse('Bash', { command: 'pwd' }, 'toolu_g13') ]));

    expect(renderer.display(toolResult('toolu_g13', 'ok'))).toBe('> ok\n');
  });

  test('displayClaudeEvent never tags: a fresh renderer has no memory across calls', () => {
    const call = assistant([
      toolUse('Bash', { command: 'ls' }, 'toolu_g14'),
      toolUse('Bash', { command: 'pwd' }, 'toolu_g15'),
    ]);
    displayClaudeEvent(call, plain);

    expect(displayClaudeEvent(toolResult('toolu_g14', 'ok'), plain)).toBe('> ok\n');
  });
});

describe('verbosity gates', () => {
  test('suppresses unrecognized events unless verbose or debug', () => {
    const event = { type: 'something-new', payload: 1 };

    expect(displayClaudeEvent(event, plain)).toBe('');
    expect(displayClaudeEvent(event, verbose)).toBe(`${JSON.stringify(event)}\n`);
    expect(displayClaudeEvent(event, debug)).toBe(`${JSON.stringify(event)}\n`);
  });

  test('verbose-only events stay hidden by default', () => {
    const event = { type: 'permission-mode', permissionMode: 'default' };

    expect(displayClaudeEvent(event, plain)).toBe('');
    expect(displayClaudeEvent(event, verbose)).toBe('• Permission Mode default\n');
  });

  test('recognizes the 2.1.220 mode record instead of dumping it', () => {
    const event = { type: 'mode', mode: 'normal', sessionId: 'abc' };

    expect(displayClaudeEvent(event, plain)).toBe('');
    expect(displayClaudeEvent(event, verbose)).toBe('• Mode normal\n');
  });

  test('renders the generated session title', () => {
    expect(displayClaudeEvent({ type: 'ai-title', aiTitle: 'Fix the thing' }, plain))
      .toBe('• AI Title\n| Fix the thing\n');
  });

  test('suppresses recognized records under --debug, keeps unhandled tools', () => {
    expect(displayClaudeEvent(assistant([ { type: 'text', text: 'hello' } ]), debug)).toBe('');

    const other = assistant([ toolUse('NewTool', { a: 1 }, 'toolu_o1') ]);

    expect(displayClaudeEvent(other, debug)).toBe('• Tool\n| NewTool\n| {"a":1}\n');
    expect(displayClaudeEvent(other, plain)).toBe('• Tool\n| NewTool\n| {"a":1}\n');
  });

  test('under --debug an unhandled tool still shows next to suppressed blocks', () => {
    const event = assistant([ { type: 'text', text: 'hi' }, toolUse('NewTool', {}, 'toolu_o2') ]);

    expect(displayClaudeEvent(event, debug)).toBe('• Tool\n| NewTool\n| {}\n');
  });

  test('--debug no longer dumps records a Verbose rule understands', () => {
    // A Verbose rule matches and renders nothing; only the JSON fallback,
    // reserved for shapes no rule knows, may speak under --debug.
    expect(displayClaudeEvent({ type: 'permission-mode', permissionMode: 'default' }, debug))
      .toBe('');
    expect(displayClaudeEvent({ type: 'mode', mode: 'normal' }, debug)).toBe('');
  });

  test('renders a known tool whose input its own guard rejects', () => {
    // Measured 2026-07-26: 2 such calls left in the local corpus, both a Read
    // whose arguments failed to parse. The name-based exclusion list used to
    // render every one of them as nothing. (A TaskUpdate missing `status` used
    // to be 7 more of these; isTaskUpdateBlock now accepts the partial update.)
    const unparsed = assistant([ toolUse('Read', { __unparsedToolInput: { raw: '{bad' } }) ]);

    expect(displayClaudeEvent(unparsed, plain))
      .toBe('• Tool\n| Read\n| {"__unparsedToolInput":{"raw":"{bad"}}\n');
  });

  test('a verbose-only tool block stays quiet instead of falling to the catch-all', () => {
    const event = assistant([ toolUse('ToolSearch', { query: 'q' }) ]);

    expect(displayClaudeEvent(event, plain)).toBe('');
    expect(displayClaudeEvent(event, verbose)).toBe('• Tool Search\n| q\n');
  });
});
