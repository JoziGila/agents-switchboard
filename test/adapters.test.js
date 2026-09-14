import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteResponsesRequest, mapDeepSeekError, usageFromResponsesEvent } from '../src/adapters/responses.js';
import { rewriteMessagesRequest, hasUnsignedThinking, stripUnsignedThinking, normalizeSseData } from '../src/adapters/messages.js';
import { isDeepSeekModel, mergeModels, rewriteEtag, deepseekEntries } from '../src/catalog.js';
import * as adaptersForAgentMessage from '../src/adapters/responses.js';
import * as messagesForUsage from '../src/adapters/messages.js';

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
  assert.deepEqual(out.tools.map((t) => t.name), ['exec_command', 'apply_patch', 'mcp__x__js']);
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
  const merged = mergeModels({ models: [{ slug: 'gpt-5.5', multi_agent_version: 'v2' }, { slug: 'deepseek-flash', display_name: 'already' }] }, entries);
  assert.deepEqual(merged.models.map((m) => m.slug), ['gpt-5.5', 'deepseek-flash']);
  assert.equal(merged.models[0].multi_agent_version, 'v1', 'parent models are served as v1 so spawn payloads stay plaintext');
  assert.equal(mergeModels({ models: [{ slug: 'g', multi_agent_version: 'v2' }] }, [], { forceMultiAgentV1: false }).models[0].multi_agent_version, 'v2');
  assert.equal(rewriteEtag('"abc"', 'h1'), '"abc+sbh1"');
  assert.equal(rewriteEtag(undefined, 'h1'), '"sbh1"');
});

// ---- provider profiles and DeepSeek-harness rules ----
import { DEEPSEEK_RESPONSES, OPENROUTER_RESPONSES, mapEffort, mapUpstreamError, reasoningIdsFromEvent, EMPTY_OUTPUT_PLACEHOLDER } from '../src/adapters/responses.js';
import { DEEPSEEK_MESSAGES, OPENROUTER_MESSAGES } from '../src/adapters/messages.js';

const frozen = (o) => JSON.parse(JSON.stringify(o));

test('effort ladders: three-level and four-level mapping', () => {
  const three = ['low', 'high', 'max'], four = ['minimal', 'low', 'medium', 'high'];
  for (const [from, to] of [['minimal', 'low'], ['none', 'low'], ['low', 'low'], ['medium', 'high'], ['high', 'high'], ['xhigh', 'max'], ['max', 'max'], ['ultra', 'max'], ['weird', 'high']]) assert.equal(mapEffort(from, three), to, `3-level ${from}`);
  for (const [from, to] of [['none', 'minimal'], ['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'high'], ['max', 'high'], ['ultra', 'high'], ['weird', 'high']]) assert.equal(mapEffort(from, four), to, `4-level ${from}`);
  assert.equal(mapEffort('xhigh', null), 'xhigh', 'null ladder passes through');
});

test('responses: openrouter profile keeps 4-level efforts, drops custom tools, keeps empty output', () => {
  const body = { model: 'qwen/qwen3-coder[1m]', reasoning: { effort: 'xhigh' }, tools: [{ type: 'custom', name: 'apply_patch' }, { type: 'function', name: 'f' }], input: [{ type: 'function_call_output', call_id: 'c', output: '' }] };
  const out = rewriteResponsesRequest(body, OPENROUTER_RESPONSES);
  assert.equal(out.model, 'qwen/qwen3-coder');
  assert.equal(out.reasoning.effort, 'high');
  assert.deepEqual(out.tools.map((t) => t.name), ['f']);
  assert.equal(out.input[0].output, '', 'no placeholder on openrouter');
  const ds = rewriteResponsesRequest(body, DEEPSEEK_RESPONSES);
  assert.equal(ds.reasoning.effort, 'max');
  assert.deepEqual(ds.tools.map((t) => t.name), ['apply_patch', 'f']);
  assert.equal(ds.input[0].output, EMPTY_OUTPUT_PLACEHOLDER);
});

test('responses: assistant content is never empty; empty tool output gets the placeholder (deepseek)', () => {
  const body = { input: [
    { type: 'message', role: 'assistant', content: [] },
    { type: 'message', role: 'assistant' },
    { type: 'message', role: 'user', content: [] },
    { type: 'function_call_output', call_id: 'c1', output: [] },
    { type: 'function_call_output', call_id: 'c2', output: 'real' },
  ] };
  const out = rewriteResponsesRequest(frozen(body));
  assert.deepEqual(out.input[0].content, [{ type: 'output_text', text: '' }]);
  assert.deepEqual(out.input[1].content, [{ type: 'output_text', text: '' }]);
  assert.deepEqual(out.input[2].content, [], 'user messages untouched');
  assert.equal(out.input[3].output, EMPTY_OUTPUT_PLACEHOLDER);
  assert.equal(out.input[4].output, 'real');
  assert.deepEqual(rewriteResponsesRequest(out), out, 'idempotent');
});

test('responses: encrypted_content kept only when the profile vouches for the item', () => {
  const body = { input: [
    { type: 'reasoning', id: 'rs_ours', encrypted_content: 'E1', summary: [] },
    { type: 'reasoning', id: 'rs_foreign', encrypted_content: 'E2', summary: [] },
    { type: 'reasoning', id: 'rs_text', encrypted_content: 'E3', summary: [{ type: 'summary_text', text: 'kept text' }] },
  ] };
  const profile = { ...OPENROUTER_RESPONSES, keepEncryptedContent: (i) => i.id === 'rs_ours' };
  const out = rewriteResponsesRequest(frozen(body), profile);
  assert.deepEqual(out.input.map((i) => i.id), ['rs_ours', 'rs_text']);
  assert.equal(out.input[0].encrypted_content, 'E1');
  assert.ok(!('encrypted_content' in out.input[1]));
  assert.equal(out.input[1].summary[0].text, 'kept text', 'reasoning text replayed byte-exact');
  assert.equal(body.input[1].encrypted_content, 'E2', 'input not mutated');
});

test('messages: openrouter profile passes adaptive thinking, structured output, efforts and documents', () => {
  const body = { model: 'anthropic/claude-sonnet-5[1m]', thinking: { type: 'adaptive', display: 'omitted' }, output_config: { effort: 'xhigh', format: { type: 'json_schema' } },
    messages: [{ role: 'user', content: [{ type: 'document', source: {} }, { type: 'text', text: 'q' }] }, { role: 'system', content: [{ type: 'text', text: 'mid' }] }] };
  const { body: out, notes } = rewriteMessagesRequest(frozen(body), OPENROUTER_MESSAGES);
  assert.equal(out.model, 'anthropic/claude-sonnet-5');
  assert.deepEqual(out.thinking, { type: 'adaptive' }, 'display dropped, adaptive kept');
  assert.deepEqual(out.output_config, { effort: 'xhigh', format: { type: 'json_schema' } });
  assert.equal(out.messages[0].content.length, 2, 'documents kept');
  assert.equal(out.messages[1].role, 'user', 'mid-conversation system still converted');
  assert.deepEqual(notes, ['system-role→user']);
});

test('messages: deepseek profile maps efforts and fills empty assistant content and tool results', () => {
  const body = { model: 'deepseek-flash', output_config: { effort: 'medium' }, messages: [
    { role: 'assistant', content: [] },
    { role: 'assistant', content: 'fine' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [] }, { type: 'tool_result', tool_use_id: 't2', content: 'x' }] },
  ] };
  const { body: out } = rewriteMessagesRequest(frozen(body));
  assert.deepEqual(out.output_config, { effort: 'high' });
  assert.equal(out.messages[0].content, '');
  assert.equal(out.messages[1].content, 'fine');
  assert.equal(out.messages[2].content[0].content, EMPTY_OUTPUT_PLACEHOLDER);
  assert.equal(out.messages[2].content[1].content, 'x');
  assert.deepEqual(rewriteMessagesRequest(out).body, out, 'idempotent');
  const or = rewriteMessagesRequest(frozen(body), OPENROUTER_MESSAGES).body;
  assert.equal(or.output_config.effort, 'medium', 'null ladder passes through');
  assert.deepEqual(or.messages[2].content[0].content, [], 'no placeholder on openrouter');
});

test('error mapping never emits 401/402/403 and parses the OpenRouter envelope', () => {
  for (const s of [401, 402, 403]) {
    const m = mapUpstreamError(s, '{"error":{"message":"nope"}}', 'openrouter');
    assert.equal(m.status, 400, `${s} → 400`);
    assert.match(m.body.error.message, /^openrouter: nope \(check the openrouter API key or credits\)$/);
  }
  const or = mapUpstreamError(429, JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded', metadata: { error_type: 'rate_limit_exceeded', provider_name: 'DeepSeek' } } }), 'openrouter');
  assert.equal(or.status, 429);
  assert.equal(or.body.error.type, 'rate_limit_exceeded');
  assert.equal(or.body.error.message, 'openrouter: Rate limit exceeded [rate_limit_exceeded, provider DeepSeek]');
  assert.equal(mapUpstreamError(503, 'down').body.error.type, 'server_error');
  assert.equal(mapUpstreamError(400, 'bad').status, 400);
  assert.equal(mapDeepSeekError(401, 'x').status, 400, 'alias still works');
});

test('usage cost and reasoning ids from events', () => {
  const done = { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2, cost: 0.0012 }, output: [{ type: 'reasoning', id: 'rs_1' }, { type: 'message', id: 'm' }, { type: 'reasoning', id: 'rs_2' }] } };
  assert.deepEqual(usageFromResponsesEvent(done), { input: 10, cached: 0, output: 2, usd: 0.0012 });
  assert.deepEqual(reasoningIdsFromEvent(done), ['rs_1', 'rs_2']);
  assert.deepEqual(reasoningIdsFromEvent({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_9' } }), ['rs_9']);
  assert.deepEqual(reasoningIdsFromEvent({ type: 'response.output_item.done', item: { type: 'message', id: 'm' } }), []);
  assert.deepEqual(reasoningIdsFromEvent({ type: 'ping' }), []);
});

test('codex agent_message items become plain user messages; encrypted payloads are flagged, not dropped silently', () => {
  const { rewriteResponsesRequest } = adaptersForAgentMessage;
  const plain = { type: 'agent_message', id: 'amsg_1', author: '/root', recipient: '/root/x', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\nwhat is 2+2?' }] };
  const enc = { type: 'agent_message', id: 'amsg_2', author: '/root', recipient: '/root/x', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: 'gAAAA' }] };
  const out = rewriteResponsesRequest({ model: 'deepseek-flash', input: [plain, enc] });
  assert.equal(out.input[0].type, 'message');
  assert.equal(out.input[0].role, 'user');
  assert.deepEqual(out.input[0].content, [{ type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\nwhat is 2+2?' }]);
  assert.equal(out.input[1].type, 'message');
  assert.match(out.input[1].content[0].text, /encrypted by the vendor/);
});

test('responses usage is normalised to the native shape for Codex', () => {
  const { normalizeResponsesSseData } = adaptersForAgentMessage;
  const d = normalizeResponsesSseData('{"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":7,"prompt_cache_hit_tokens":90}}}');
  const u = JSON.parse(d).response.usage;
  assert.equal(u.total_tokens, 107);
  assert.equal(u.input_tokens_details.cached_tokens, 90);
  assert.equal(u.output_tokens_details.reasoning_tokens, 0);
  assert.equal(normalizeResponsesSseData('{"type":"response.output_text.delta","delta":"x"}'), '{"type":"response.output_text.delta","delta":"x"}');
});

test('namespaced tools are encoded on the wire and decoded back into namespace + name', () => {
  const { rewriteResponsesRequest, namespacedToolMap, codexSseMapper } = adaptersForAgentMessage;
  const tools = [{ type: 'namespace', name: 'collaboration', description: 'Agents', tools: [{ type: 'function', name: 'spawn_agent', description: 'Spawn', parameters: {} }] }, { type: 'namespace', name: 'mcp__cua_repl', tools: [{ type: 'function', name: 'js' }] }, { type: 'function', name: 'exec_command' }];
  const out = rewriteResponsesRequest({ model: 'deepseek-flash', tools, input: [{ type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', call_id: 'c1', arguments: '{}' }] });
  assert.deepEqual(out.tools.map((t) => t.name), ['collaboration__spawn_agent', 'mcp__cua_repl__js', 'exec_command']);
  assert.match(out.tools[0].description, /^\[collaboration\] Spawn/);
  assert.equal(out.input[0].name, 'collaboration__spawn_agent');
  assert.ok(!('namespace' in out.input[0]));
  const map = namespacedToolMap(tools);
  const mapper = codexSseMapper(map);
  const added = mapper('{"type":"response.output_item.added","item":{"type":"function_call","name":"mcp__cua_repl__js","call_id":"c2","arguments":""}}');
  assert.deepEqual(JSON.parse(added).item, { type: 'function_call', name: 'js', namespace: 'mcp__cua_repl', call_id: 'c2', arguments: '' });
  const done = mapper('{"type":"response.completed","response":{"output":[{"type":"function_call","name":"exec_command"}],"usage":{"input_tokens":1,"output_tokens":1}}}');
  const j = JSON.parse(done);
  assert.equal(j.response.output[0].name, 'exec_command');
  assert.equal(j.response.usage.total_tokens, 2);
});

test('anthropic usage: message_delta with only output_tokens does not zero earlier counts; input is the full prompt', () => {
  const { usageFromMessagesEvent } = messagesForUsage;
  const start = usageFromMessagesEvent({ type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 40000, cache_creation_input_tokens: 900, output_tokens: 1 } } });
  assert.deepEqual(start, { input: 40912, cached: 40000, output: 1 });
  const delta = usageFromMessagesEvent({ type: 'message_delta', usage: { output_tokens: 250 } });
  assert.deepEqual(delta, { output: 250 });
  const merged = { ...start, ...delta };
  assert.deepEqual(merged, { input: 40912, cached: 40000, output: 250 });
});

test('reasoning from another provider is dropped; the provider\'s own is replayed (model switch mid-conversation)', () => {
  const { rewriteResponsesRequest, DEEPSEEK_RESPONSES } = adaptersForAgentMessage;
  const own = new Set(['rs_ds_1']);
  const profile = { ...DEEPSEEK_RESPONSES, ownsReasoning: (i) => own.has(i.id) };
  const input = [
    { type: 'reasoning', id: 'rs_gpt_7', summary: [{ type: 'summary_text', text: 'gpt thought' }], content: [{ type: 'reasoning_text', text: 'raw' }], encrypted_content: 'E' },
    { type: 'reasoning', id: 'rs_ds_1', summary: [{ type: 'summary_text', text: 'ds thought' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ];
  const out = rewriteResponsesRequest({ model: 'deepseek-flash', input }, profile);
  assert.deepEqual(out.input.map((i) => i.id ?? i.type), ['rs_ds_1', 'message']);
  assert.equal(rewriteResponsesRequest({ model: 'deepseek-flash', input }, DEEPSEEK_RESPONSES).input.length, 3, 'without a provenance hook nothing is dropped');
});
