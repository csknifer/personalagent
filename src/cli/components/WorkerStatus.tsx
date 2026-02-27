/**
 * Worker status display component with enhanced progress tracking
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Spinner } from './Spinner.js';
import type { WorkerState, AgentPhase, LLMCallStats } from '../../core/types.js';

interface WorkerStatusProps {
  workers: WorkerState[];
  visible?: boolean;
  /** Show detailed view with LLM calls and tool usage */
  verbose?: boolean;
  /** Current agent phase */
  phase?: AgentPhase;
  /** LLM call statistics */
  llmStats?: LLMCallStats;
}

export const WorkerStatus: React.FC<WorkerStatusProps> = ({ 
  workers, 
  visible = true,
  verbose = false,
  phase,
  llmStats,
}) => {
  if (!visible || workers.length === 0) {
    return null;
  }

  const activeWorkers = workers.filter(w => w.status === 'working' || w.status === 'verifying');
  const completedWorkers = workers.filter(w => w.status === 'completed');
  const failedWorkers = workers.filter(w => w.status === 'failed');

  return (
    <Box flexDirection="column" {...(verbose ? { borderStyle: 'single' as const, borderColor: 'gray', paddingX: 1 } : { marginLeft: 2 })} marginTop={0} marginBottom={0}>
      <Box justifyContent="space-between">
        <Text color="yellow" bold>Workers</Text>
        {phase && phase !== 'idle' && (
          <Text color="cyan" dimColor>[{phase}]</Text>
        )}
      </Box>
      
      {activeWorkers.slice(0, 5).map(worker => (
        <WorkerItem key={worker.id} worker={worker} verbose={verbose} />
      ))}
      {activeWorkers.length > 5 && (
        <Text color="gray" dimColor>  +{activeWorkers.length - 5} more workers...</Text>
      )}
      
      {completedWorkers.length > 0 && (
        <Text color="green">
          ✓ {completedWorkers.length} completed
        </Text>
      )}
      
      {failedWorkers.length > 0 && (
        <Text color="red">
          ✗ {failedWorkers.length} failed
        </Text>
      )}

      {verbose && llmStats && llmStats.total > 0 && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            LLM: {llmStats.total} calls | {llmStats.totalTokens.total} tokens
          </Text>
        </Box>
      )}
    </Box>
  );
};

interface WorkerItemProps {
  worker: WorkerState;
  verbose?: boolean;
}

const WorkerItem: React.FC<WorkerItemProps> = ({ worker, verbose = false }) => {
  const getStatusIcon = () => {
    switch (worker.status) {
      case 'working':
        return <Spinner />;
      case 'verifying':
        return <Text color="yellow">⋯</Text>;
      case 'completed':
        return <Text color="green">✓</Text>;
      case 'failed':
        return <Text color="red">✗</Text>;
      default:
        return <Text color="gray">○</Text>;
    }
  };

  const taskDescription = worker.currentTask?.description || 'Unknown task';
  const truncatedDesc = taskDescription.length > 45 
    ? taskDescription.slice(0, 42) + '...' 
    : taskDescription;

  // Create progress indicator
  const maxIterations = worker.maxIterations || 5;
  const progressPercent = Math.round((worker.iteration / maxIterations) * 100);

  return (
    <Box flexDirection="column" marginY={0}>
      {/* Main worker line */}
      <Box gap={1}>
        {getStatusIcon()}
        <Text color="cyan">[{formatWorkerId(worker.id)}]</Text>
        <Text>{truncatedDesc}</Text>
      </Box>
      
      {/* Progress details line */}
      {(worker.status === 'working' || worker.status === 'verifying') && (
        <Box marginLeft={3}>
          {worker.currentAction ? (
            <Text color="gray" dimColor>
              {truncateAction(worker.currentAction, 55)}
            </Text>
          ) : (
            <Text color="gray" dimColor>
              Iteration {worker.iteration}/{maxIterations}
            </Text>
          )}
        </Box>
      )}

      {/* Verbose stats line */}
      {verbose && (worker.status === 'working' || worker.status === 'verifying') && (
        <Box marginLeft={3} gap={2}>
          <Text color="gray" dimColor>
            Iter: {worker.iteration}/{maxIterations}
          </Text>
          <Text color="gray" dimColor>
            LLM: {worker.llmCalls || 0}
          </Text>
          <Text color="gray" dimColor>
            Tools: {worker.toolCalls || 0}
          </Text>
          <ProgressBar percent={progressPercent} width={10} />
        </Box>
      )}
    </Box>
  );
};

/**
 * Format worker ID to be shorter
 */
function formatWorkerId(id: string): string {
  if (id.length <= 8) return id;
  // If it looks like a UUID, take first 8 chars
  if (id.includes('-')) {
    return id.split('-')[0];
  }
  return id.slice(0, 8);
}

/**
 * Truncate action string to max length
 */
function truncateAction(action: string, maxLength: number): string {
  if (action.length <= maxLength) return action;
  return action.slice(0, maxLength - 3) + '...';
}

/**
 * Simple progress bar component
 */
interface ProgressBarProps {
  percent: number;
  width?: number;
}

const ProgressBar: React.FC<ProgressBarProps> = ({ percent, width = 10 }) => {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  
  return (
    <Text>
      <Text color="green">{'█'.repeat(filled)}</Text>
      <Text color="gray">{'░'.repeat(empty)}</Text>
      <Text color="gray" dimColor> {percent}%</Text>
    </Text>
  );
};

/**
 * Compact worker summary for header display
 */
interface WorkerSummaryProps {
  workers: WorkerState[];
  phase?: AgentPhase;
}

export const WorkerSummary: React.FC<WorkerSummaryProps> = ({ workers, phase }) => {
  if (workers.length === 0) return null;

  const activeCount = workers.filter(w => w.status === 'working' || w.status === 'verifying').length;
  const completedCount = workers.filter(w => w.status === 'completed').length;
  const totalCount = workers.length;

  const phaseLabel = phase && phase !== 'idle' ? ` [${phase}]` : '';

  return (
    <Box gap={1}>
      <Spinner />
      <Text color="yellow">
        Workers: {activeCount} active / {completedCount} done / {totalCount} total{phaseLabel}
      </Text>
    </Box>
  );
};
