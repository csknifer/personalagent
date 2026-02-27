/**
 * DiscoveryCoordinator — multi-wave investigative execution
 *
 * Sits between Queen and WorkerPool. Runs waves of workers,
 * accumulates findings, uses LLM to decide what to investigate
 * next at each wave boundary.
 */

import type { LLMProvider } from '../../providers/Provider.js';
import type { ChatOptions } from '../../providers/Provider.js';
import type { WorkerPool } from '../worker/WorkerPool.js';
import type { ProgressiveDiscoveryConfig } from '../../config/types.js';
import type {
  Task,
  TaskResult,
  TaskPlan,
  Finding,
  WaveResult,
  WaveDecision,
  AgentEventHandler,
  SkillContext,
  Message,
} from '../types.js';
import { KnowledgeGraph } from '../knowledge/KnowledgeGraph.js';
import { GraphExtractor } from '../knowledge/GraphExtractor.js';
import type { WorkerExtractionInput } from '../knowledge/GraphExtractor.js';
import { extractScratchpad } from '../worker/ralphUtils.js';

export interface DiscoveryCoordinatorOptions {
  provider: LLMProvider;
  workerPool: WorkerPool;
  config: ProgressiveDiscoveryConfig;
}

export interface DiscoveryExecuteOptions {
  eventHandler: AgentEventHandler;
  skillContext?: SkillContext;
  conversationContext?: string;
  toolNames?: string[];
  toolDescriptions?: string[];
}

export interface DiscoveryResult {
  content: string;
  findings: Finding[];
  waveCount: number;
  waveHistory: WaveResult[];
}

export class DiscoveryCoordinator {
  private provider: LLMProvider;
  private workerPool: WorkerPool;
  private config: ProgressiveDiscoveryConfig;

  constructor(options: DiscoveryCoordinatorOptions) {
    this.provider = options.provider;
    this.workerPool = options.workerPool;
    this.config = options.config;
  }

  async execute(
    request: string,
    initialPlan: TaskPlan,
    options: DiscoveryExecuteOptions,
  ): Promise<DiscoveryResult> {
    const { eventHandler } = options;
    const allFindings: Finding[] = [];
    const waveHistory: WaveResult[] = [];
    const abandonedDirections: string[] = [];
    const totalStart = Date.now();
    const graph = new KnowledgeGraph();
    const extractor = new GraphExtractor(this.provider);

    // Phase: discovering
    eventHandler({ type: 'phase_change', phase: 'discovering', description: 'Starting progressive discovery' });

    let currentTasks = this.prefixTaskIds(initialPlan.tasks ?? [], 1);

    for (let wave = 1; wave <= this.config.maxWaves; wave++) {
      // Check totalTimeout hard stop
      if (Date.now() - totalStart > this.config.totalTimeout) {
        break;
      }

      // Emit wave start
      eventHandler({
        type: 'discovery_wave_start',
        waveNumber: wave,
        taskCount: currentTasks.length,
        reasoning: wave === 1 ? initialPlan.reasoning : 'Continuing investigation',
      });

      // Emit worker_spawned for each task
      for (const task of currentTasks) {
        eventHandler({ type: 'worker_spawned', workerId: task.id, task });
      }

      // For wave 2+, inject discovery context into tasks
      if (wave > 1) {
        const discoveryContext = graph.getStats().entityCount > 0
          ? this.formatGraphContext(graph, abandonedDirections)
          : this.formatDiscoveryContext(allFindings, waveHistory, abandonedDirections);
        for (const task of currentTasks) {
          if (!task.dependencyResults) {
            task.dependencyResults = new Map();
          }
          task.dependencyResults.set('discovery-context', discoveryContext);
        }
      }

      // Execute wave with per-wave timeout
      const waveStart = Date.now();
      let waveTimer: ReturnType<typeof setTimeout> | undefined;
      const results = await Promise.race([
        this.workerPool.executeTasks(currentTasks),
        new Promise<Map<string, TaskResult>>((_, reject) => {
          waveTimer = setTimeout(
            () => reject(new Error(`Wave ${wave} timed out after ${this.config.waveTimeout}ms`)),
            this.config.waveTimeout,
          );
        }),
      ]).catch(() => new Map<string, TaskResult>())
        .finally(() => {
          if (waveTimer) clearTimeout(waveTimer);
        });
      const waveDuration = Date.now() - waveStart;

      // Collect findings from results
      const waveFindings = this.collectFindings(currentTasks, results, wave);

      // Deduplicate against accumulated findings
      const newFindings = this.deduplicateFindings(waveFindings, allFindings);
      allFindings.push(...newFindings);

      // --- Knowledge graph extraction ---
      const extractionInputs: WorkerExtractionInput[] = [];
      for (const task of currentTasks) {
        const result = results.get(task.id);
        if (result?.success) {
          extractionInputs.push({
            workerId: task.id,
            findings: result.findings ?? [],
            scratchpad: extractScratchpad(result.output),
          });
        }
      }
      const extracted = await extractor.extract(extractionInputs);
      const workerIds = extractionInputs.map(i => i.workerId);
      graph.merge(extracted.entities, extracted.relationships, wave, workerIds);

      // Emit worker_completed for each task
      for (const task of currentTasks) {
        const result = results.get(task.id);
        if (result) {
          eventHandler({ type: 'worker_completed', workerId: task.id, result });
        }
      }

      // Record wave result
      const waveResult: WaveResult = {
        waveNumber: wave,
        tasks: currentTasks,
        results,
        findings: newFindings,
        duration: waveDuration,
      };
      waveHistory.push(waveResult);

      // Emit wave complete
      eventHandler({
        type: 'discovery_wave_complete',
        waveNumber: wave,
        newFindings: newFindings.map(f => f.content),
        totalFindings: allFindings.length,
      });

      // If last wave, break (don't ask LLM)
      if (wave >= this.config.maxWaves) {
        break;
      }

      // Ask LLM: plan next wave
      const decision = await this.planNextWave(request, allFindings, waveHistory, abandonedDirections);

      // Emit decision
      eventHandler({
        type: 'discovery_decision',
        waveNumber: wave,
        decision: decision.action,
        reasoning: decision.reasoning,
      });

      if (decision.action === 'sufficient') {
        break;
      }

      if (decision.action === 'pivot') {
        abandonedDirections.push(...decision.abandonedDirections);
      }

      // Prepare next wave tasks
      if (decision.action === 'continue' || decision.action === 'pivot') {
        currentTasks = this.prefixTaskIds(decision.tasks, wave + 1);
      }
    }

    // Aggregation phase
    eventHandler({ type: 'phase_change', phase: 'aggregating', description: 'Synthesizing discovery findings' });

    const content = await this.aggregate(request, allFindings, waveHistory, graph);

    return {
      content,
      findings: allFindings,
      waveCount: waveHistory.length,
      waveHistory,
    };
  }

  /**
   * Collect Finding objects from task results for a given wave.
   */
  private collectFindings(tasks: Task[], results: Map<string, TaskResult>, wave: number): Finding[] {
    const findings: Finding[] = [];
    for (const task of tasks) {
      const result = results.get(task.id);
      if (result?.success && result.findings) {
        for (const finding of result.findings) {
          findings.push({
            content: finding,
            source: task.id,
            confidence: result.bestScore ?? 0.7,
            wave,
            tags: [],
          });
        }
      }
    }
    return findings;
  }

  /**
   * Remove findings that duplicate existing ones (exact match or high bigram similarity).
   */
  private deduplicateFindings(newFindings: Finding[], existing: Finding[]): Finding[] {
    const accepted: Finding[] = [];
    for (const newF of newFindings) {
      const isDuplicateOfExisting = existing.some(existingF => {
        if (newF.content === existingF.content) return true;
        return this.stringSimilarity(newF.content, existingF.content) > 0.85;
      });
      const isDuplicateWithinBatch = accepted.some(acceptedF => {
        if (newF.content === acceptedF.content) return true;
        return this.stringSimilarity(newF.content, acceptedF.content) > 0.85;
      });
      if (!isDuplicateOfExisting && !isDuplicateWithinBatch) {
        accepted.push(newF);
      }
    }
    return accepted;
  }

  /**
   * Bigram-based Sorensen-Dice coefficient for string similarity.
   */
  private stringSimilarity(a: string, b: string): number {
    const normalize = (s: string) => s.toLowerCase().trim();
    const na = normalize(a);
    const nb = normalize(b);
    if (na === nb) return 1.0;
    if (na.length < 2 || nb.length < 2) return 0.0;

    const bigrams = (s: string): Map<string, number> => {
      const map = new Map<string, number>();
      for (let i = 0; i < s.length - 1; i++) {
        const bigram = s.slice(i, i + 2);
        map.set(bigram, (map.get(bigram) ?? 0) + 1);
      }
      return map;
    };

    const bigramsA = bigrams(na);
    const bigramsB = bigrams(nb);
    let intersection = 0;

    for (const [bigram, countA] of bigramsA) {
      const countB = bigramsB.get(bigram) ?? 0;
      intersection += Math.min(countA, countB);
    }

    const totalBigrams = (na.length - 1) + (nb.length - 1);
    return (2 * intersection) / totalBigrams;
  }

  /**
   * Build context string for next wave's workers.
   */
  private formatDiscoveryContext(
    findings: Finding[],
    waveHistory: WaveResult[],
    abandonedDirections: string[],
  ): string {
    const parts: string[] = [];

    parts.push(`## Discovery Context (${waveHistory.length} waves completed)`);

    if (findings.length > 0) {
      parts.push('\n### Key Findings So Far');
      for (const f of findings) {
        parts.push(`- [Wave ${f.wave}, confidence ${f.confidence.toFixed(1)}] ${f.content}`);
      }
    }

    if (abandonedDirections.length > 0) {
      parts.push('\n### Abandoned Directions (do not revisit)');
      for (const d of abandonedDirections) {
        parts.push(`- ${d}`);
      }
    }

    parts.push('\n### Instructions');
    parts.push('Build on previous findings. Do NOT repeat what has already been discovered.');
    parts.push('Focus on deepening understanding and cross-referencing across sources.');

    return parts.join('\n');
  }

  /**
   * Build structured graph context for next wave's workers.
   */
  private formatGraphContext(
    graph: KnowledgeGraph,
    abandonedDirections: string[],
  ): string {
    const parts: string[] = [];

    parts.push(graph.getContext(''));

    if (abandonedDirections.length > 0) {
      parts.push('\n### Abandoned Directions (do not revisit)');
      for (const d of abandonedDirections) {
        parts.push(`- ${d}`);
      }
    }

    parts.push('\n### Instructions');
    parts.push('Build on previous findings. Do NOT repeat what has already been discovered.');
    parts.push('Focus on deepening understanding and cross-referencing across sources.');

    return parts.join('\n');
  }

  /**
   * Ask LLM to decide what to do after a wave completes.
   */
  private async planNextWave(
    request: string,
    findings: Finding[],
    waveHistory: WaveResult[],
    abandonedDirections: string[],
  ): Promise<WaveDecision> {
    const systemMessage = `You are a research coordinator deciding whether to continue investigating or stop.

RULES:
- DEEPEN, do not REPEAT — never re-investigate what was already found
- Reference specific findings from prior waves
- Prioritize cross-referencing between findings
- Detect diminishing returns — if new waves produce few novel insights, stop
- Return ONLY valid JSON

Return JSON in one of these formats:
1. {"action": "sufficient", "reasoning": "..."}
2. {"action": "continue", "reasoning": "...", "tasks": [{"id": "...", "description": "...", "successCriteria": "..."}]}
3. {"action": "pivot", "reasoning": "...", "tasks": [...], "abandonedDirections": ["..."]}`;

    const findingsSummary = findings
      .map(f => `[Wave ${f.wave}] ${f.content}`)
      .join('\n');

    const userMessage = `Original request: ${request}

Waves completed: ${waveHistory.length}
Total findings: ${findings.length}

Current findings:
${findingsSummary}

${abandonedDirections.length > 0 ? `Abandoned directions: ${abandonedDirections.join(', ')}` : ''}

Should we continue investigating, or do we have sufficient information?`;

    const messages: Message[] = [
      { role: 'system', content: systemMessage, timestamp: new Date() },
      { role: 'user', content: userMessage, timestamp: new Date() },
    ];

    try {
      const response = await this.provider.chat(messages, { temperature: 0.3 } as ChatOptions);
      return this.parseWaveDecision(response.content);
    } catch {
      // Fail-safe: stop on error
      return { action: 'sufficient', reasoning: 'LLM call failed, stopping discovery' };
    }
  }

  /**
   * Parse LLM response into a WaveDecision. Fail-safe to "sufficient".
   */
  private parseWaveDecision(response: string): WaveDecision {
    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonStr = response.trim();
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      const parsed = JSON.parse(jsonStr);

      if (parsed.action === 'sufficient') {
        return { action: 'sufficient', reasoning: parsed.reasoning ?? 'No reasoning provided' };
      }

      if (parsed.action === 'continue' || parsed.action === 'pivot') {
        const tasks = this.parseTasks(parsed.tasks ?? []);
        if (tasks.length === 0) {
          return { action: 'sufficient', reasoning: 'No tasks proposed, stopping' };
        }

        if (parsed.action === 'pivot') {
          return {
            action: 'pivot',
            tasks,
            reasoning: parsed.reasoning ?? '',
            abandonedDirections: parsed.abandonedDirections ?? [],
          };
        }

        return { action: 'continue', tasks, reasoning: parsed.reasoning ?? '' };
      }

      return { action: 'sufficient', reasoning: 'Unrecognized action, stopping' };
    } catch {
      return { action: 'sufficient', reasoning: 'Failed to parse LLM decision, stopping' };
    }
  }

  /**
   * Parse raw task objects from LLM output into Task[].
   */
  private parseTasks(raw: Array<{ id?: string; description?: string; successCriteria?: string }>): Task[] {
    return raw
      .filter(t => t.description)
      .map((t, i) => ({
        id: t.id ?? `task-${i + 1}`,
        description: t.description!,
        successCriteria: t.successCriteria ?? 'Complete successfully',
        dependencies: [],
        priority: 1,
        status: 'pending' as const,
        createdAt: new Date(),
      }));
  }

  /**
   * Prefix all task IDs with wave number to avoid collisions.
   */
  private prefixTaskIds(tasks: Task[], wave: number): Task[] {
    return tasks.map(t => ({
      ...t,
      id: `w${wave}-${t.id}`,
      status: 'pending' as const,
      createdAt: new Date(),
    }));
  }

  /**
   * Aggregate findings into a final response.
   * Single wave with single successful result passes through directly.
   */
  private async aggregate(
    request: string,
    findings: Finding[],
    waveHistory: WaveResult[],
    graph?: KnowledgeGraph,
  ): Promise<string> {
    // Single wave, single successful result — pass through directly
    if (waveHistory.length === 1) {
      const results = waveHistory[0].results;
      const successResults = Array.from(results.values()).filter(r => r.success);
      if (successResults.length === 1) {
        return successResults[0].output;
      }
    }

    // Use graph synthesis view if available, otherwise fall back to wave-based findings
    const graphView = graph?.getSynthesisView();
    const hasGraph = graphView && graphView.length > 0;

    const systemMessage = hasGraph
      ? `You are synthesizing findings from a multi-wave investigation.
You have access to a structured knowledge graph extracted from the research.

Produce a structured profile:
- Use the knowledge graph structure to organize your response
- Note confidence levels and corroboration status
- Flag contradictions and single-source claims explicitly
- Acknowledge gaps where information is missing
- Be comprehensive but concise`
      : `You are synthesizing findings from a multi-wave investigation.

Produce a structured profile of what was discovered:
- Group findings by category
- Note confidence levels (high/medium/low)
- Flag any contradictions between findings
- Acknowledge gaps where information is missing
- Be comprehensive but concise`;

    const contentSection = hasGraph
      ? graphView
      : waveHistory.map(w => {
          const waveFindingsList = w.findings
            .map(f => `  - [confidence: ${f.confidence.toFixed(1)}] ${f.content}`)
            .join('\n');
          return `Wave ${w.waveNumber} (${w.findings.length} new findings):\n${waveFindingsList}`;
        }).join('\n\n');

    const userMessage = `Original request: ${request}

Investigation spanned ${waveHistory.length} waves with ${findings.length} total findings.

${contentSection}

Synthesize these findings into a comprehensive response.`;

    const messages: Message[] = [
      { role: 'system', content: systemMessage, timestamp: new Date() },
      { role: 'user', content: userMessage, timestamp: new Date() },
    ];

    try {
      const response = await this.provider.chat(messages, { temperature: 0.3 } as ChatOptions);
      return response.content;
    } catch {
      // Fallback: return raw findings
      return findings.map(f => `- ${f.content}`).join('\n');
    }
  }
}
