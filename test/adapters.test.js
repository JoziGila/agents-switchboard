import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteResponsesRequest, mapDeepSeekError, usageFromResponsesEvent } from '../src/adapters/responses.js';
import { rewriteMessagesRequest, hasUnsignedThinking, stripUnsignedThinking, normalizeSseData } from '../src/adapters/messages.js';
import { isDeepSeekModel, mergeModels, rewriteEtag, deepseekEntries } from '../src/catalog.js';

const codexBody = {
  model: 'deepseek-flash', instructions: 'You are Codex', stream: true, store: false,
  include: ['reasoning.encrypted_content'], prompt_cache_key: 'k', text: { verbosity: 'low' },
  client_metadata: { session_id: 's' }, reasoning: { effort: 'xhigh', summary: 'auto' }, parallel_tool_calls: true, tool_choice: 'auto',
  input: [
    { type: 'message', id: 'msg_1', role: 'developer', content: [{ type: 'input_text', text: 'ctx' }], internal_chat_message_metadata_passthrough: { create_time: 1 } },
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'ZZZ', summary: [] },
    { type: 'reasoning', id: 'rs_2', encrypted_content: 'YYY', summary: [{ type: 'summary_text', text: 'thought' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ],
  tools: [
    { type: 'function', name: 'exec_command', parameters: {} },
    { type: 'custom', name: 'apply_patch', format: { type: 'grammar' } },
    { type: 'custom', name: 'other_custom' },
    { type: 'namespace', name: 'mcp__x', tools: [{ type: 'function', name: 'js' }] },
    { type: 'tool_search' }, { type: 'web_search' },
  ],
};

test('responses adapter strips what DeepSeek cannot use and keeps the prefix', () => {
  const out = rewriteResponsesRequest(codexBody);
  for (const k of ['store', 'prompt_cache_key', 'text', 'client_metadata', 'include']) assert.ok(!(k in out), k);
  assert.equal(out.instructions, 'You are Codex');
  assert.deepEqual(out.reasoning, { effort: 'max' });
  assert.equal(out.input.length, 3, 'empty reasoning item dropped, others kept in order');
  assert.ok(!('internal_chat_message_metadata_passthrough' in out.input[0]));
  assert.ok(!('encrypted_content' in out.input[1]));
  assert.equal(out.input[1].summary[0].text, 'thought');
  assert.deepEqual(out.tools.map((t) => t.name), ['exec_command', 'apply_patch', 'js']);
  assert.equal(codexBody.include.length, 1, 'input not mutated');
  assert.deepEqual(rewriteResponsesRequest(codexBody), out, 'deterministic');
});

test('responses adapter maps efforts', () => {
  for (const [from, to] of [['low', 'low'], ['medium', 'high'], ['high', 'high'], ['xhigh', 'max'], ['ultra', 'max'], ['weird', 'high']]) {
    assert.equal(rewriteResponsesRequest({ reasoning: { effort: from } }).reasoning.effort, to);
  }
});

test('deepseek error mapping', () => {
  assert.equal(mapDeepSeekError(401, '{"error":{"message":"bad key"}}').status, 400, 'never 401 to the client');
  assert.equal(mapDeepSeekError(429, 'slow').body.error.type, 'rate_limit_exceeded');
  assert.equal(mapDeepSeekError(503, 'x').body.error.type, 'server_error');
  assert.equal(mapDeepSeekError(400, 'x').status, 400);
});

test('responses usage reads both spellings', () => {
  assert.deepEqual(usageFromResponsesEvent({ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 90 } } } }), { input: 100, cached: 90, output: 5 });
  assert.deepEqual(usageFromResponsesEvent({ response: { usage: { input_tokens: 10, output_tokens: 1, prompt_cache_hit_tokens: 4 } } }), { input: 10, cached: 4, output: 1 });
});

const claudeBody = {
  model: 'deepseek-flash[1m]', max_tokens: 64000, stream: true,
  thinking: { type: 'adaptive', display: 'omitted' },
  output_config: { effort: 'high', format: { type: 'json_schema', schema: {} } },
  context_management: { edits: [] },
  system: [{ type: 'text', text: 'x-anthropic-billing-header: cc' }, { type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'document', source: {} }] },
    { role: 'system', content: [{ type: 'text', text: 'mid-conversation' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 'sig' }, { type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'redacted_thinking', data: 'x' }] },
  ],
};

test('messages adapter rewrites for DeepSeek', () => {
  const { body, notes } = rewriteMessagesRequest(claudeBody);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.deepEqual(body.output_config, { effort: 'high' });
  assert.equal(body.system, claudeBody.system, 'system array untouched');
  assert.equal(body.messages.length, 3, 'empty message dropped');
  assert.equal(body.messages[0].content.length, 1);
  assert.equal(body.messages[1].role, 'user');
  assert.equal(body.messages[2].content[0].signature, 'sig', 'thinking untouched');
  assert.ok(notes.length >= 3);
  assert.equal(claudeBody.messages[1].role, 'system', 'input not mutated');
});

test('unsigned thinking is detected and stripped for anthropic', () => {
  const b = { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'ds' }, { type: 'text', text: 'a' }] }, { role: 'user', content: 'q' }] };
  assert.equal(hasUnsignedThinking(b), true);
  assert.equal(hasUnsignedThinking(claudeBody), false);
  const s = stripUnsignedThinking(b);
  assert.deepEqual(s.messages[0].content, [{ type: 'text', text: 'a' }]);
  assert.equal(hasUnsignedThinking(s), false);
});

test('usage normalisation fills anthropic cache fields', () => {
  const d = normalizeSseData('{"type":"message_delta","usage":{"input_tokens":10,"output_tokens":3,"prompt_cache_hit_tokens":7}}');
  assert.deepEqual(JSON.parse(d).usage, { input_tokens: 10, output_tokens: 3, prompt_cache_hit_tokens: 7, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 });
  assert.equal(normalizeSseData('{"type":"ping"}'), '{"type":"ping"}');
  const untouched = '{"type":"message_delta","usage":{"cache_read_input_tokens":1}}';
  assert.equal(normalizeSseData(untouched), untouched);
});

test('catalog helpers', () => {
  assert.equal(isDeepSeekModel('deepseek-flash[1m]'), true);
  assert.equal(isDeepSeekModel('gpt-5.5'), false);
  assert.equal(isDeepSeekModel(null), false);
  const entries = deepseekEntries(['deepseek-flash']);
  assert.equal(entries.length, 1);
  const merged = mergeModels({ models: [{ slug: 'gpt-5.5' }, { slug: 'deepseek-flash', display_name: 'already' }] }, entries);
  assert.deepEqual(merged.models.map((m) => m.slug), ['gpt-5.5', 'deepseek-flash']);
  assert.equal(rewriteEtag('"abc"', 'h1'), '"abc+sbh1"');
  assert.equal(rewriteEtag(undefined, 'h1'), '"sbh1"');
});
