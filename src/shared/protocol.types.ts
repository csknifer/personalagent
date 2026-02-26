/**
 * Shared protocol types used by both the server (src/server/) and web client (web/src/).
 *
 * IMPORTANT: This file must NOT import from any Node.js-specific modules.
 * It is copied to web/src/lib/ as a pre-build step.
 *
 * To update: edit this file, then run `npm run sync:types` (or it runs
 * automatically as part of dev:web and build:web).
 */

export type AgentPhase = 'idle' | 'planning' | 'executing' | 'verifying' | 'aggregating' | 'replanning' | 'evaluating' | 'discovering';

export interface MessageMetadata {
  tokenCount?: number;
  model?: string;
  provider?: string;
  workerId?: string;
  skill?: string;
}

export interface LLMCallStats {
  total: number;
  byPurpose: Record<string, number>;
  byProvider: Record<string, number>;
  totalTokens: { input: number; output: number; total: number };
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'done';
  content?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
}
