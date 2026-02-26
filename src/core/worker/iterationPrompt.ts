/**
 * Prompt builders for Ralph Loop iterations.
 */

import type { ToolDefinition } from '../../providers/index.js';
import type { RalphLoopContext } from './verifiers.js';

/**
 * Build system prompt with tool descriptions
 */
export function buildToolSystemPrompt(tools: ToolDefinition[]): string {
  const today = new Date().toISOString().split('T')[0];
  const toolDescriptions = tools.map(t =>
    `- **${t.name}**: ${t.description}`
  ).join('\n');

  const toolNames = new Set(tools.map(t => t.name));

  // Dynamically build research strategy based on what search tools are actually available
  const searchTools = [
    toolNames.has('search') && '`search`',
    toolNames.has('web_search') && '`web_search`',
  ].filter(Boolean);
  const hasSearch = searchTools.length > 0;
  const hasFetchUrl = toolNames.has('fetch_url');
  const hasGlob = toolNames.has('glob');
  const hasGrep = toolNames.has('grep');
  const hasShell = toolNames.has('execute_command');

  const researchStrategy = hasSearch
    ? `- **Research tasks**: Use ${searchTools.join(' or ')} to find information, then use \`fetch_url\` on the most relevant results to get full page content. Chain tool calls — don't stop at search snippets.`
    : hasFetchUrl
    ? `- **Research tasks**: Use \`fetch_url\` to retrieve content directly from relevant URLs (news sites, official pages, financial data sites, etc.). Try multiple URLs if one fails.`
    : `- **Research tasks**: Use available tools to gather information from files or execute commands to retrieve data.`;

  const codeStrategy = (hasGlob || hasGrep || hasShell)
    ? `- **Code/file tasks**: Use \`glob\` to find files, \`grep\` to search content, \`read_file\`/\`write_file\` to edit, \`execute_command\` to run builds/tests/git operations.`
    : `- **File tasks**: Use \`list_directory\` to understand structure, \`read_file\` to examine content, \`write_file\` to create/modify. Check \`file_exists\` before assuming files are present.`;

  return `You are a task-focused worker agent. Complete your assigned task using the tools below.

## Current Date
${today}

## Available Tools
${toolDescriptions}

## Tool Strategy
${researchStrategy}
${codeStrategy}
- **Always use tools** when they can provide specific, current data. Don't refuse to try a tool when one is available.
- If a tool call fails, try different parameters or an alternative tool. If multiple tools fail, try different search terms or alternative sources.

## CRITICAL: Data Integrity
- ONLY present data that came from actual tool results. NEVER fabricate, invent, or hallucinate data.
- If a tool call returns an error (403, 404, timeout, etc.), report that the data could not be retrieved — do NOT make up plausible-looking numbers or quotes.
- If all tool attempts fail, clearly state what you could not retrieve and provide whatever partial information you did successfully obtain.
- It is ALWAYS better to say "I could not retrieve X" than to present fabricated data as real.

## Output Quality
- Include specific data, numbers, and quotes — only from actual tool results
- Cite sources with URLs when doing research — only URLs you actually fetched
- Structure your response clearly — use headings for multi-part answers
- Provide substantive content, not filler or transition phrases

## Key Findings
At the END of your response, include a tagged section listing the most important facts, data points, and conclusions you discovered:

## KEY FINDINGS
- [Concise finding 1 — specific fact, number, or conclusion]
- [Concise finding 2]
- [Up to 10 most important findings]

Each finding should be a single, self-contained bullet that would make sense to another agent without additional context. Focus on specific data (numbers, names, URLs, dates) rather than vague summaries. If you used tools, include the specific data retrieved. Omit this section only if you produced no substantive findings.

## Scratchpad (Optional)
You may maintain a private scratchpad to track your reasoning state across iterations:

## SCRATCHPAD
- [Strategy note: tried X, didn't work because Y]
- [Hypothesis: Z might be the issue]
- [Dead end: don't try approach W again]

Unlike KEY FINDINGS (facts for the final output), scratchpad entries are your private reasoning notes about approach and strategy.

## Data Retention (Optional)
If a tool returns critical data you'll need to reference in later iterations, mark it for retention:

RETAIN: tool_call_id_here

This ensures the full tool output survives context compression across iterations.`;
}

/**
 * Build the prompt for an iteration
 */
export function buildIterationPrompt(context: RalphLoopContext): string {
  let prompt = `
## Task
${context.task.description}

## Success Criteria
${context.task.successCriteria}

`;

  // Compressed conversation context for workers (episodic memory)
  if (context.task.conversationSummary) {
    prompt += `## Conversation Context\n${context.task.conversationSummary}\n\n`;
  }
  if (context.task.userPreferences && context.task.userPreferences.length > 0) {
    prompt += `## User Preferences\n${context.task.userPreferences.map(p => `- ${p}`).join('\n')}\n\n`;
  }

  // Tool effectiveness hints from session history (procedural memory)
  if (context.task.toolEffectivenessHints) {
    prompt += `## Tool Effectiveness (from prior tasks this session)\n${context.task.toolEffectivenessHints}\n\n`;
  }

  // Cross-session strategy hints (long-term memory)
  if (context.task.strategyHints) {
    prompt += `## Session Strategy Notes\n${context.task.strategyHints}\n\n`;
  }

  // Worker scratchpad: persistent reasoning state across iterations
  if (context.scratchpad && context.scratchpad.length > 0) {
    prompt += `## Working Scratchpad (your reasoning notes from previous iterations)\nThese are your private reasoning notes. Use them to track your approach:\n`;
    for (const entry of context.scratchpad) {
      prompt += `- ${entry}\n`;
    }
    prompt += `\nUpdate your scratchpad in your response under a ## SCRATCHPAD section.\n\n`;
  }

  // Retained tool results from previous iterations (selective attention)
  if (context.retainedToolResults && context.retainedToolResults.size > 0) {
    prompt += `## Retained Tool Results (marked as critical in previous iterations)\n`;
    for (const [id, result] of context.retainedToolResults) {
      prompt += `### ${id}\n${result}\n\n`;
    }
  }

  // Add dependency results if this task depends on completed tasks
  if (context.task.dependencyResults && context.task.dependencyResults.size > 0) {
    prompt += `## Context from Completed Dependencies\n\n`;
    for (const [depId, output] of context.task.dependencyResults) {
      prompt += `### ${depId}\n${output}\n\n`;
    }
  }

  // Add skill context if available
  if (context.task.skillContext) {
    prompt += `
## Skill Guidance: ${context.task.skillContext.name}

Follow these skill instructions to help complete the task:

${context.task.skillContext.instructions}

`;

    // Add resources if available
    if (context.task.skillContext.resources && context.task.skillContext.resources.size > 0) {
      prompt += `### Skill Resources\n\n`;
      for (const [name, content] of context.task.skillContext.resources) {
        prompt += `**${name}:**\n${content}\n\n`;
      }
    }
  }

  // Inject accumulated findings from previous iterations
  if (context.findings && context.findings.length > 0) {
    prompt += `## Established Findings (from previous iterations)\nThese are confirmed facts you have already discovered. Build on them, don't re-research them:\n`;
    for (const finding of context.findings) {
      prompt += `- ${finding}\n`;
    }
    prompt += `\n`;
  }

  if (context.iteration > 1 && context.previousAttempts.length > 0) {
    const prevAttempt = context.previousAttempts[context.previousAttempts.length - 1];
    prompt += `
## Previous Attempt
${prevAttempt}

`;
  }

  // Structural tool failure awareness (from previous iteration)
  if (context.iteration > 1 && context.lastToolFailures && context.lastToolFailures.length > 0) {
    prompt += `## ⚠ Tool Failures from Previous Attempt (programmatically verified)
The following tools FAILED in your last attempt — they returned errors, not data:
${context.lastToolFailures.map(f => `- **${f.tool}**: ${f.error}`).join('\n')}

You MUST NOT present data from these failed tools as if they succeeded. Instead:
- Try alternative tools or different parameters
- If no alternative works, explicitly state what data could not be retrieved
- Partial honest results are always better than fabricated complete results

`;
  }

  if (context.feedback.length > 0) {
    // Show up to last 3 feedback entries to avoid excessive length
    const recentFeedback = context.feedback.slice(-3);
    const feedbackStartIter = context.iteration - recentFeedback.length;
    prompt += `\n## Feedback from Verification\n`;
    for (let i = 0; i < recentFeedback.length; i++) {
      const iterNum = feedbackStartIter + i;
      if (recentFeedback.length > 1) {
        prompt += `### Iteration ${iterNum} feedback\n`;
      }
      prompt += `${recentFeedback[i]}\n\n`;
    }
    if (recentFeedback.length > 1) {
      prompt += `Address ALL the feedback above, not just the most recent.\n\n`;
    }
  }

  // DCL: Convergence state section
  if (context.convergenceState && context.convergenceState.signals.size > 0) {
    prompt += `## Convergence State\n`;
    for (const [name, signal] of context.convergenceState.signals) {
      const scores = context.convergenceState.history.get(name) || [];
      const latest = scores.length > 0 ? scores[scores.length - 1].toFixed(2) : '?';
      const trend = scores.length >= 2 ? scores.slice(-3).map(s => s.toFixed(2)).join(' → ') : latest;
      prompt += `- **${name}**: ${signal.toUpperCase()} (${trend})\n`;
    }
    prompt += '\n';
  }

  // Reflexion: strategic guidance section
  if (context.reflexionGuidance) {
    prompt += `## Strategic Guidance
${context.reflexionGuidance}

`;
  }

  // Stall detection: force strategy change
  if (context.stallDetected) {
    prompt += `## CRITICAL: Strategy Change Required
Your previous two attempts produced nearly identical output. You MUST try a fundamentally different approach:
- Use different tools or different search queries
- Restructure your response format
- Approach the problem from a different angle
Do NOT repeat the same strategy — it has already failed twice.

`;
  }

  // Detect if feedback mentions data integrity issues (fabrication, hallucination, mismatch)
  const lastFeedback = context.feedback[context.feedback.length - 1] || '';
  const hasIntegrityIssue = /fabricat|hallucin|contradict|integrity|mismatch|false|invented|made.up|not verified|doesn't match/i.test(lastFeedback);

  if (hasIntegrityIssue) {
    prompt += `## CRITICAL: Data Integrity Violation Detected
Your previous response contained data that does NOT match your actual tool outputs. This is the #1 priority to fix.
- ONLY include data that appears verbatim in successful tool results
- If a tool returned an error (403, 404, timeout), say "Could not retrieve [X] due to [error]" — do NOT invent data
- If you cannot fulfill a criterion because tools failed, explicitly state that rather than fabricating an answer
- Partial honest results are ALWAYS preferred over complete fabricated results

`;
  }

  // Instructions: selective focus for DCL, generic otherwise
  if (context.failingCriteria && context.failingCriteria.length > 0) {
    prompt += `## Instructions
Your previous output was partially correct. Focus on improving ONLY these failing criteria:
${context.failingCriteria.map(c => `- ${c}`).join('\n')}

Keep the parts of your response that already meet the passing criteria. Modify surgically — don't rewrite what's working.
`;
  } else if (context.feedback.length > 0) {
    prompt += `## Instructions
Review the feedback above and address the specific issues identified. Don't repeat the same approach that produced the feedback — change your strategy.
`;
  } else {
    prompt += `## Instructions
Complete this task thoroughly. Ensure your response meets ALL success criteria listed above. Use available tools to gather specific data rather than relying on general knowledge.
`;
  }

  return prompt;
}
