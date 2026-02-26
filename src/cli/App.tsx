/**
 * Main CLI Application component with Queen-based hive architecture
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useApp } from 'ink';
import { Header, ChatInput, MessageList, Spinner, WorkerStatus } from './components/index.js';
import { useQueen } from './hooks/index.js';
import type { LLMProvider } from '../providers/index.js';
import type { ResolvedConfig } from '../config/types.js';
import type { MCPServer } from '../mcp/MCPServer.js';
import type { SkillLoader } from '../skills/SkillLoader.js';
import type { SkillTracker } from '../skills/SkillTracker.js';
import type { HistoryManager } from '../core/HistoryManager.js';
import type { StrategyStore } from '../core/queen/StrategyStore.js';
import type { MemoryStore } from '../core/memory/MemoryStore.js';
import { getProgressTracker } from '../core/progress/ProgressTracker.js';
import { getShutdownManager } from '../core/ShutdownManager.js';
import type { AgentPhase } from '../core/types.js';

interface AppProps {
  config: ResolvedConfig;
  queenProvider: LLMProvider;
  workerProvider: LLMProvider;
  mcpServer: MCPServer;
  skillLoader?: SkillLoader | null;
  skillTracker?: SkillTracker | null;
  historyManager?: HistoryManager | null;
  strategyStore?: StrategyStore | null;
  memoryStore?: MemoryStore | null;
}

export const App: React.FC<AppProps> = ({ config, queenProvider, workerProvider, mcpServer, skillLoader, skillTracker, historyManager, strategyStore, memoryStore }) => {
  const { exit } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [providerInfo] = useState({
    name: config.hive.queen.provider || config.activeProvider,
    model: config.hive.queen.model || config.activeModel,
  });

  const handleError = useCallback((err: Error) => {
    setError(err.message);
    setTimeout(() => setError(null), 5000);
  }, []);

  const { messages, isLoading, streamingContent, workers, reasoning, phase, llmStats, sendMessage, clearMessages, getWorkerStats } = useQueen({
    queenProvider,
    workerProvider,
    mcpServer,
    config,
    skillLoader: skillLoader ?? undefined,
    skillTracker: skillTracker ?? undefined,
    historyManager: historyManager ?? undefined,
    strategyStore: strategyStore ?? undefined,
    memoryStore: memoryStore ?? undefined,
    onError: handleError,
  });

  const handleCommand = useCallback((command: string, args: string[]) => {
    switch (command.toLowerCase()) {
      case 'help':
        console.log(`
Commands:
  /help              - Show this help message
  /quit, /exit       - Exit the application
  /clear, /reset     - Clear chat history and start fresh
  /config show       - Show current configuration
  /config provider   - Show/set provider (e.g., /config provider openai)
  /config model      - Show/set model (e.g., /config model gpt-4o)
  /workers           - Show worker status and stats
  /progress          - Show detailed progress and LLM call statistics
  /skills            - List available skills
  /skills info <id>  - Show skill details
  /skills stats      - Show skill usage statistics
  /skills suggest    - Get suggestions for new skills
        `);
        break;

      case 'quit':
      case 'exit':
        getShutdownManager().shutdown('user_exit').then(() => exit());
        break;

      case 'clear':
        clearMessages();
        console.log('\n\x1b[32m✓ Chat cleared.\x1b[0m Context reset, ready for a fresh conversation.\n');
        break;

      case 'reset':
        // Alias for clear
        clearMessages();
        console.log('\n\x1b[32m✓ Session reset.\x1b[0m All context cleared, starting fresh.\n');
        break;

      case 'config':
        if (args[0] === 'show') {
          const providerCfg = config.providers[providerInfo.name];
          const temp = providerCfg && typeof providerCfg === 'object' ? providerCfg.temperature : 0.7;
          console.log(`
Current Configuration:
  Queen Provider: ${providerInfo.name}
  Queen Model: ${providerInfo.model}
  Worker Provider: ${config.hive.worker.provider || providerInfo.name}
  Worker Model: ${config.hive.worker.model || 'default'}
  Temperature: ${temp ?? 0.7}
  Max Workers: ${config.hive.worker.maxConcurrent}
          `);
        } else if (args[0] === 'provider') {
          if (args[1]) {
            console.log(`Provider switching requires restart. Use: pa --provider ${args[1]}`);
          } else {
            console.log(`Current provider: ${providerInfo.name}`);
          }
        } else if (args[0] === 'model') {
          if (args[1]) {
            console.log(`Model switching requires restart. Use: pa --model ${args[1]}`);
          } else {
            console.log(`Current model: ${providerInfo.model}`);
          }
        } else {
          console.log('Usage: /config show | provider [name] | model [name]');
        }
        break;

      case 'workers':
        const stats = getWorkerStats();
        console.log(`
Worker Pool Status:
  Total Workers: ${stats.totalWorkers}
  Active Workers: ${stats.activeWorkers}
  Queued Tasks: ${stats.queuedTasks}
  Max Workers: ${stats.maxWorkers}
        `);
        if (workers.length > 0) {
          console.log('\nActive Workers:');
          for (const worker of workers) {
            const action = worker.currentAction ? ` - ${worker.currentAction}` : '';
            const llmInfo = worker.llmCalls ? ` | LLM: ${worker.llmCalls}` : '';
            const toolInfo = worker.toolCalls ? ` | Tools: ${worker.toolCalls}` : '';
            console.log(`  - ${worker.id}: ${worker.status} (iter ${worker.iteration}/${worker.maxIterations || 10})${llmInfo}${toolInfo}${action}`);
          }
        }
        break;

      case 'progress':
        try {
          const tracker = getProgressTracker();
          const progressState = tracker.getCurrentProgress();
          const llmStats = tracker.getLLMCallStats();
          const workerProgress = tracker.getWorkerProgress();
          
          console.log('\n=== Progress Report ===\n');
          console.log(`Phase: ${progressState.phase}`);
          
          if (progressState.startedAt) {
            const duration = Math.round((Date.now() - progressState.startedAt.getTime()) / 1000);
            console.log(`Duration: ${duration}s`);
          }
          
          console.log('');
          console.log('LLM Calls:');
          console.log(`  Total: ${llmStats.total}`);
          
          // Show by purpose
          const purposes = Object.entries(llmStats.byPurpose).filter(([, count]) => count > 0);
          if (purposes.length > 0) {
            console.log('  By Purpose:');
            for (const [purpose, count] of purposes) {
              console.log(`    ${purpose}: ${count}`);
            }
          }
          
          // Show by provider
          const providers = Object.entries(llmStats.byProvider);
          if (providers.length > 0) {
            console.log('  By Provider:');
            for (const [provider, count] of providers) {
              console.log(`    ${provider}: ${count}`);
            }
          }
          
          console.log(`  Tokens: ${llmStats.totalTokens.input} in / ${llmStats.totalTokens.output} out (${llmStats.totalTokens.total} total)`);
          
          // Show worker details
          if (workerProgress.length > 0) {
            console.log('');
            console.log('Workers:');
            for (const worker of workerProgress) {
              const statusIcon = worker.status === 'completed' ? '✓' :
                                worker.status === 'failed' ? '✗' :
                                worker.status === 'working' ? '◉' :
                                worker.status === 'verifying' ? '⋯' : '○';
              const desc = worker.taskDescription.length > 40 
                ? worker.taskDescription.slice(0, 37) + '...' 
                : worker.taskDescription;
              console.log(`  ${statusIcon} [${worker.id.slice(0, 8)}] ${desc}`);
              console.log(`    Status: ${worker.status} | Iteration: ${worker.iteration}/${worker.maxIterations}`);
              console.log(`    LLM Calls: ${worker.llmCalls} | Tool Calls: ${worker.toolCalls}`);
              if (worker.currentAction) {
                console.log(`    Current: ${worker.currentAction}`);
              }
            }
          }
          
          console.log('');
        } catch (err) {
          console.log('Progress tracking not available.');
        }
        break;

      case 'skills':
        if (!skillLoader) {
          console.log('Skills are not enabled. Check your configuration.');
          break;
        }
        
        if (args[0] === 'info' && args[1]) {
          const skill = skillLoader.getSkill(args[1]);
          if (skill) {
            console.log(`
Skill: ${skill.metadata.name}
Version: ${skill.metadata.version || '1.0.0'}
Author: ${skill.metadata.author || 'Unknown'}

Description:
  ${skill.metadata.description}

Triggers:
  ${skill.metadata.triggers?.join(', ') || 'None defined'}

Tags:
  ${skill.metadata.tags?.join(', ') || 'None'}

Path: ${skill.path}
            `);
          } else {
            console.log(`Skill not found: ${args[1]}`);
            console.log('Use /skills to list available skills.');
          }
        } else if (args[0] === 'stats') {
          if (!skillTracker) {
            console.log('Skill tracking is not enabled.');
            break;
          }
          
          const summary = skillTracker.getSummary();
          console.log(`
Skill Usage Statistics:

  Total Invocations: ${summary.totalInvocations}
  Unique Skills Used: ${summary.uniqueSkillsUsed}
  Success Rate: ${summary.successRate.toFixed(1)}%
  Unmatched Queries: ${summary.unmatchedCount}
`);
          
          if (summary.topSkills.length > 0) {
            console.log('Top Skills:');
            for (const skill of summary.topSkills) {
              console.log(`  - ${skill.name}: ${skill.count} uses`);
            }
            console.log('');
          }

          // Show unmatched patterns as opportunities for new skills
          const unmatched = skillTracker.getUnmatchedPatterns(2);
          if (unmatched.length > 0) {
            console.log('Frequent Unmatched Queries (potential new skills):');
            for (const q of unmatched.slice(0, 5)) {
              console.log(`  - "${q.query}" (${q.count}x)`);
            }
            console.log('');
          }
        } else if (args[0] === 'suggest') {
          if (!skillTracker) {
            console.log('Skill tracking is not enabled.');
            break;
          }
          
          // Get new skill suggestions
          const suggestions = skillTracker.suggestNewSkills();
          
          if (suggestions.length === 0) {
            console.log('\nNo skill suggestions yet. Keep using the agent to generate learning data.\n');
          } else {
            console.log('\nSuggested New Skills:\n');
            for (const suggestion of suggestions) {
              console.log(`  ${suggestion.name}`);
              console.log(`    ${suggestion.description}`);
              console.log(`    Triggers: ${suggestion.suggestedTriggers.join(', ')}`);
              console.log(`    Based on ${suggestion.queryCount} unmatched queries\n`);
            }
            console.log('Use "create skill" to create a new skill based on these suggestions.\n');
          }

          // Get learning insights
          const learning = skillTracker.learnFromFeedback();
          
          if (learning.skillsWithIssues.length > 0) {
            console.log('Skills needing attention:');
            for (const skill of learning.skillsWithIssues) {
              console.log(`  - ${skill.skillName}: ${skill.notHelpfulRate.toFixed(0)}% unhelpful rate`);
            }
            console.log('');
          }

          if (learning.suggestedAdditions.length > 0) {
            console.log('Suggested trigger additions:');
            for (const addition of learning.suggestedAdditions.slice(0, 5)) {
              console.log(`  - Add "${addition.trigger}" to skill`);
            }
            console.log('');
          }
        } else if (args[0] === 'list' || !args[0]) {
          const skills = skillLoader.getAllSkills();
          if (skills.length === 0) {
            console.log('No skills discovered. Add skills to ./skills or ~/.personalagent/skills');
          } else {
            console.log(`\nAvailable Skills (${skills.length}):\n`);
            for (const skill of skills) {
              const triggers = skill.metadata.triggers?.slice(0, 3).join(', ') || '';
              console.log(`  ${skill.id}`);
              console.log(`    ${skill.metadata.name}: ${skill.metadata.description}`);
              if (triggers) {
                console.log(`    Triggers: ${triggers}${(skill.metadata.triggers?.length || 0) > 3 ? '...' : ''}`);
              }
              console.log('');
            }
          }
        } else {
          console.log('Usage: /skills [list] | info <skill-id> | stats | suggest');
        }
        break;

      default:
        console.log(`Unknown command: /${command}. Type /help for available commands.`);
    }
  }, [exit, clearMessages, config, providerInfo, workers, getWorkerStats, skillLoader, skillTracker]);

  const phaseLabel = (p: AgentPhase): string => {
    switch (p) {
      case 'planning':    return 'Planning task decomposition...';
      case 'executing':   return 'Executing tasks...';
      case 'verifying':   return 'Verifying results...';
      case 'aggregating': return 'Aggregating worker results...';
      default:            return 'Processing...';
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Header provider={providerInfo.name} model={providerInfo.model} llmStats={llmStats} />

      {error && (
        <Box>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}

      <Box flexDirection="column" flexGrow={1}>
        <MessageList messages={messages} streamingContent={streamingContent} />
      </Box>

      {/* Status area: appears during loading with per-worker progress */}
      {isLoading && (
        <Box flexDirection="column" marginTop={1}>
          {/* Spinner + reasoning or phase label */}
          <Box>
            <Spinner />
            <Text color="cyan" dimColor>
              {' '}{reasoning
                ? (reasoning.length > 74 ? reasoning.slice(0, 71) + '...' : reasoning)
                : phaseLabel(phase)}
            </Text>
          </Box>

          {/* Detailed worker status when workers are active */}
          {config.cli.showWorkerStatus && workers.length > 0 && (
            <WorkerStatus
              workers={workers}
              visible={true}
              verbose={config.cli.verboseWorkerStatus}
              phase={phase}
              llmStats={llmStats ?? undefined}
            />
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <ChatInput
          onSubmit={sendMessage}
          onCommand={handleCommand}
          disabled={isLoading}
          placeholder="Ask me anything..."
        />
      </Box>
    </Box>
  );
};
