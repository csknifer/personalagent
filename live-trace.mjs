/**
 * Live trace test — runs real API calls through the full pipeline
 * and captures every LLM prompt, response, tool call, and event.
 *
 * Usage: node live-trace.mjs
 */

import 'dotenv/config';
import { bootstrap } from './src/bootstrap.js';
import { Queen } from './src/core/queen/Queen.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const TEST_QUERY = 'Compare PostgreSQL vs MongoDB for a startup building a real-time analytics dashboard. Delegate this research to workers for a thorough comparison.';
const MAX_WAIT_MS = 3 * 60 * 1000; // 3 minute overall timeout (workers timeout at 120s)

// ─── Trace collection ────────────────────────────────────────────────────────

const trace = {
  events: [],
  llmCalls: [],
  toolCalls: [],
  systemPrompts: {},
  startTime: null,
  endTime: null,
};

function elapsed() {
  return ((Date.now() - trace.startTime) / 1000).toFixed(1);
}

function log(tag, msg) {
  console.log(`[${elapsed()}s] [${tag}] ${msg}`);
}

// ─── Provider monkey-patching ────────────────────────────────────────────────
// Wraps chat() to capture the full prompt and response at the raw level.

function patchProvider(provider, label) {
  const originalChat = provider.chat.bind(provider);
  let callNum = 0;

  provider.chat = async function (messages, options) {
    callNum++;
    const id = `${label}-${callNum}`;
    const purpose = options?.purpose || options?.metadata?.purpose || 'unknown';
    const workerId = options?.workerId || options?.metadata?.workerId || null;
    const tag = workerId ? `${label}/${workerId}` : label;

    // Capture the system prompt on first call per agent
    const systemMsg = messages.find(m => m.role === 'system');
    if (systemMsg && !trace.systemPrompts[tag]) {
      trace.systemPrompts[tag] = systemMsg.content;
    }

    // Log the last user/assistant message (trimmed)
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const userPreview = lastUserMsg
      ? lastUserMsg.content.substring(0, 200).replace(/\n/g, ' ')
      : '(no user msg)';

    log('LLM_REQ', `${tag} | purpose=${purpose} | msgs=${messages.length} | last_user: "${userPreview}"`);

    const callRecord = {
      id,
      tag,
      purpose,
      messageCount: messages.length,
      hasToolCalls: messages.some(m => m.toolCalls?.length > 0),
      hasToolResults: messages.some(m => m.toolResults?.length > 0),
      requestTime: Date.now(),
    };

    try {
      const response = await originalChat(messages, options);
      callRecord.responseTime = Date.now();
      callRecord.durationMs = callRecord.responseTime - callRecord.requestTime;
      callRecord.responsePreview = (response.content || '').substring(0, 300).replace(/\n/g, ' ');
      callRecord.toolCallsReturned = response.toolCalls?.map(tc => `${tc.name}(${JSON.stringify(tc.arguments).substring(0, 100)})`) || [];
      callRecord.tokens = response.tokenUsage;
      callRecord.success = true;

      const toolInfo = callRecord.toolCallsReturned.length > 0
        ? ` | tools: [${callRecord.toolCallsReturned.join(', ')}]`
        : '';
      log('LLM_RES', `${tag} | ${callRecord.durationMs}ms | tokens=${JSON.stringify(response.tokenUsage)}${toolInfo}`);

      if (response.content) {
        log('LLM_OUT', `${tag} | "${callRecord.responsePreview}${response.content.length > 300 ? '...' : ''}"`);
      }

      trace.llmCalls.push(callRecord);
      return response;
    } catch (err) {
      callRecord.responseTime = Date.now();
      callRecord.durationMs = callRecord.responseTime - callRecord.requestTime;
      callRecord.error = err.message;
      callRecord.success = false;
      log('LLM_ERR', `${tag} | ${callRecord.durationMs}ms | ${err.message}`);
      trace.llmCalls.push(callRecord);
      throw err;
    }
  };

  // Also patch complete() if it exists
  if (provider.complete) {
    const originalComplete = provider.complete.bind(provider);
    provider.complete = async function (prompt, options) {
      callNum++;
      const id = `${label}-complete-${callNum}`;
      log('LLM_COMPLETE', `${label} | prompt: "${prompt.substring(0, 200).replace(/\n/g, ' ')}"`);
      const result = await originalComplete(prompt, options);
      log('LLM_COMPLETE_RES', `${label} | "${(result.content || '').substring(0, 200).replace(/\n/g, ' ')}"`);
      return result;
    };
  }

  return provider;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  LIVE TRACE TEST — Full Pipeline Instrumentation');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Query: "${TEST_QUERY}"`);
  console.log('');

  // Bootstrap the system
  const b = await bootstrap({ silent: true });
  console.log(`Queen provider: ${b.queenProvider.name}/${b.queenProvider.model}`);
  console.log(`Worker provider: ${b.workerProvider.name}/${b.workerProvider.model}`);
  const availableTools = b.mcpServer.getAvailableTools();
  console.log(`MCP tools (${availableTools.length}): ${availableTools.join(', ')}`);
  console.log(`  fetch_url registered: ${availableTools.includes('fetch_url') ? '✅' : '❌'}`);
  console.log(`  web_search registered: ${availableTools.includes('web_search') ? '⚠️ (should be removed)' : '✅ (correctly absent)'}`);
  console.log('');

  // Patch providers to capture prompts/responses
  patchProvider(b.queenProvider, 'queen');
  patchProvider(b.workerProvider, 'worker');

  // Construct Queen with full instrumentation
  const queen = new Queen({
    provider: b.queenProvider,
    workerProvider: b.workerProvider,
    mcpServer: b.mcpServer,
    config: b.config,
    skillLoader: b.skillLoader,
    strategyStore: b.strategyStore,
    memoryStore: b.memoryStore,
    onEvent: (event) => {
      trace.events.push({ ...event, timestamp: Date.now() });

      switch (event.type) {
        case 'phase_change':
          log('PHASE', `${event.phase}${event.description ? ' — ' + event.description : ''}`);
          break;
        case 'worker_spawned':
          log('WORKER', `spawned ${event.workerId}: "${event.task.description.substring(0, 100)}"`);
          break;
        case 'worker_progress':
          log('WORKER', `${event.workerId} iter=${event.iteration}: ${event.status}`);
          break;
        case 'worker_completed':
          log('WORKER', `${event.workerId} DONE — success=${event.result.success}, output=${(event.result.output || '').length} chars`);
          break;
        case 'worker_state_change':
          log('WORKER', `${event.workerId} state → ${event.state?.status || JSON.stringify(event.state)}`);
          break;
        case 'tool_execution': {
          const te = event.event;
          if (te.status === 'started') {
            log('TOOL', `${te.workerId || 'queen'} → ${te.toolName}(${JSON.stringify(te.arguments || {}).substring(0, 150)})`);
          } else if (te.status === 'completed') {
            log('TOOL', `${te.workerId || 'queen'} ← ${te.toolName} (${te.durationMs}ms) preview: "${(te.resultPreview || '').substring(0, 100)}"`);
          } else {
            log('TOOL', `${te.workerId || 'queen'} ✗ ${te.toolName} ERROR: ${te.error}`);
          }
          trace.toolCalls.push(te);
          break;
        }
        case 'llm_call': {
          const lc = event.event;
          if (lc.status === 'completed') {
            log('LLM_EVENT', `${lc.workerId || 'queen'} | purpose=${lc.purpose} | ${lc.durationMs}ms | tokens=${JSON.stringify(lc.tokens)}`);
          }
          break;
        }
        case 'discovery_wave_start':
          log('DISCOVERY', `Wave ${event.waveNumber}: ${event.taskCount} tasks — ${event.reasoning}`);
          break;
        case 'discovery_wave_complete':
          log('DISCOVERY', `Wave ${event.waveNumber} done: ${event.newFindings.length} new findings (${event.totalFindings} total)`);
          break;
        case 'discovery_decision':
          log('DISCOVERY', `Wave ${event.waveNumber} decision: ${event.decision} — ${event.reasoning}`);
          break;
        case 'error':
          log('ERROR', event.error);
          break;
        default:
          log('EVENT', `${event.type}`);
      }
    },
  });

  // Run with timeout
  trace.startTime = Date.now();
  log('START', 'Sending message to Queen...');

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Overall timeout after ${MAX_WAIT_MS / 1000}s`)), MAX_WAIT_MS)
  );

  let result;
  try {
    result = await Promise.race([
      queen.processMessage(TEST_QUERY),
      timeoutPromise,
    ]);
    trace.endTime = Date.now();
  } catch (err) {
    trace.endTime = Date.now();
    log('TIMEOUT', err.message);
    result = `[TIMEOUT: ${err.message}]`;
  }

  // ─── Summary Report ──────────────────────────────────────────────────────

  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TRACE SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');

  const totalDuration = (trace.endTime - trace.startTime) / 1000;
  console.log(`\nTotal duration: ${totalDuration.toFixed(1)}s`);
  console.log(`Total LLM calls: ${trace.llmCalls.length}`);
  console.log(`Total events: ${trace.events.length}`);

  // System prompts
  console.log('\n── System Prompts ──────────────────────────────────────────');
  for (const [agent, prompt] of Object.entries(trace.systemPrompts)) {
    console.log(`\n[${agent}] (${prompt.length} chars):`);
    console.log(prompt.substring(0, 600) + (prompt.length > 600 ? '\n  ...(truncated)' : ''));
  }

  // Check critical content in queen system prompt
  console.log('\n── Queen Prompt Quality Check ──────────────────────────────');
  const queenPrompt = trace.systemPrompts['queen'] || '';
  const checks = [
    ['delegate_tasks mentioned', queenPrompt.includes('delegate_tasks')],
    ['Delegation Quality section', queenPrompt.includes('Delegation Quality')],
    ['Result Synthesis section', queenPrompt.includes('Result Synthesis')],
    ['File Operations section', queenPrompt.includes('File Operations')],
    ['NOT generic "helpful AI assistant"', !queenPrompt.includes('You are a helpful AI assistant')],
  ];
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? '✅' : '❌'} ${label}`);
  }

  // LLM call breakdown
  console.log('\n── LLM Calls by Agent/Purpose ──────────────────────────────');
  const byAgent = {};
  for (const call of trace.llmCalls) {
    const key = `${call.tag} (${call.purpose})`;
    byAgent[key] = (byAgent[key] || 0) + 1;
  }
  for (const [key, count] of Object.entries(byAgent).sort()) {
    console.log(`  ${key}: ${count} calls`);
  }

  // Tool usage
  console.log('\n── Tool Usage ──────────────────────────────────────────────');
  const toolsByName = {};
  for (const tc of trace.toolCalls) {
    if (tc.status === 'completed' || tc.status === 'started') {
      toolsByName[tc.toolName] = (toolsByName[tc.toolName] || 0) + 1;
    }
  }
  for (const [name, count] of Object.entries(toolsByName).sort()) {
    console.log(`  ${name}: ${count}`);
  }

  // Check for curl usage (Bug #4 regression)
  const curlCalls = trace.toolCalls.filter(tc =>
    tc.toolName === 'execute_command' &&
    JSON.stringify(tc.arguments || {}).includes('curl')
  );
  console.log(`\n── fetch_url vs curl Check ─────────────────────────────────`);
  console.log(`  fetch_url calls: ${toolsByName['fetch_url'] || 0}`);
  console.log(`  curl via execute_command: ${curlCalls.length}`);
  console.log(`  ${curlCalls.length === 0 ? '✅' : '❌'} Workers ${curlCalls.length === 0 ? 'correctly prefer' : 'still using curl over'} fetch_url`);

  // Worker results
  const workerCompleted = trace.events.filter(e => e.type === 'worker_completed');
  console.log(`\n── Worker Results ──────────────────────────────────────────`);
  console.log(`  Workers spawned: ${trace.events.filter(e => e.type === 'worker_spawned').length}`);
  console.log(`  Workers completed: ${workerCompleted.length}`);
  for (const wc of workerCompleted) {
    const r = wc.result;
    console.log(`  ${wc.workerId}: success=${r.success}, output=${(r.output || '').length} chars`);
  }

  // Phase timeline
  console.log('\n── Phase Timeline ─────────────────────────────────────────');
  const phaseEvents = trace.events.filter(e => e.type === 'phase_change');
  for (const pe of phaseEvents) {
    const t = ((pe.timestamp - trace.startTime) / 1000).toFixed(1);
    console.log(`  ${t}s → ${pe.phase}${pe.description ? ': ' + pe.description : ''}`);
  }

  // Final response
  console.log('\n── Final Response ─────────────────────────────────────────');
  console.log(`Length: ${(result || '').length} chars`);
  console.log(result ? result.substring(0, 1000) : '(empty)');
  if (result && result.length > 1000) {
    console.log(`... (${result.length - 1000} more chars)`);
  }

  // Overall health assessment
  console.log('\n── Health Assessment ───────────────────────────────────────');
  const issues = [];

  if (queenPrompt.includes('You are a helpful AI assistant')) {
    issues.push('❌ Queen still using generic system prompt (Bug #1 not fixed)');
  }
  if (!queenPrompt.includes('delegate_tasks')) {
    issues.push('❌ Queen prompt missing delegate_tasks guidance');
  }
  if (curlCalls.length > 0) {
    issues.push(`❌ Workers used curl ${curlCalls.length} times instead of fetch_url (Bug #4)`);
  }
  if (workerCompleted.length === 0 && trace.events.filter(e => e.type === 'worker_spawned').length > 0) {
    issues.push('❌ Workers spawned but none completed (timeout issue)');
  }
  if (!result || result.length < 100) {
    issues.push('❌ Final response too short or empty');
  }
  const failedCalls = trace.llmCalls.filter(c => !c.success);
  if (failedCalls.length > 0) {
    issues.push(`⚠️  ${failedCalls.length} LLM call(s) failed`);
  }

  if (issues.length === 0) {
    console.log('  ✅ All checks passed — pipeline is healthy');
  } else {
    for (const issue of issues) {
      console.log(`  ${issue}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');

  // Clean exit
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
