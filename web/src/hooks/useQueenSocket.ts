/**
 * WebSocket hook that mirrors the CLI's useQueen state shape.
 * Handles connection, reconnection, streaming, and event processing.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  SerializedMessage,
  SerializedWorkerState,
  SerializedAgentEvent,
  AgentPhase,
  LLMCallStats,
  ServerMessage,
  ClientMessage,
  AppState,
} from '../lib/protocol';

export interface QueenConfig {
  provider: string;
  model: string;
  workerProvider: string;
  workerModel: string;
  maxWorkers: number;
}

export interface UseQueenSocketReturn {
  messages: SerializedMessage[];
  isProcessing: boolean;
  streamingContent: string;
  streamingToolCalls: Array<{ name: string; id: string }>;
  workers: SerializedWorkerState[];
  reasoning: string | null;
  phase: AgentPhase;
  llmStats: LLMCallStats | null;
  connected: boolean;
  config: QueenConfig | null;
  sendMessage: (content: string) => void;
  clearMessages: () => void;
}

let messageCounter = 0;

function generateMessageId(): string {
  return `msg_${Date.now()}_${++messageCounter}`;
}

export function useQueenSocket(url?: string): UseQueenSocketReturn {
  const [messages, setMessages] = useState<SerializedMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingToolCalls, setStreamingToolCalls] = useState<Array<{ name: string; id: string }>>([]);
  const [workers, setWorkers] = useState<SerializedWorkerState[]>([]);
  const [reasoning, setReasoning] = useState<string | null>(null);
  const [phase, setPhase] = useState<AgentPhase>('idle');
  const [llmStats, setLlmStats] = useState<LLMCallStats | null>(null);
  const [connected, setConnected] = useState(false);
  const [config, setConfig] = useState<QueenConfig | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const reconnectAttemptRef = useRef(0);
  const streamAccumulatorRef = useRef('');
  const activeMessageIdRef = useRef<string | null>(null);

  const wsUrl = url ?? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const handleServerMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'state_snapshot':
        applyStateSnapshot(msg.state);
        break;

      case 'stream_chunk':
        if (msg.chunk.type === 'text' && msg.chunk.content) {
          streamAccumulatorRef.current += msg.chunk.content;
          setStreamingContent(streamAccumulatorRef.current);
        } else if (msg.chunk.type === 'tool_call' && msg.chunk.toolCall) {
          setStreamingToolCalls(prev => [
            ...prev,
            { name: msg.chunk.toolCall!.name, id: msg.chunk.toolCall!.id },
          ]);
        }
        break;

      case 'message_complete':
        // Move streaming content into finalized message
        setMessages(prev => [...prev, msg.message]);
        setStreamingContent('');
        setStreamingToolCalls([]);
        streamAccumulatorRef.current = '';
        activeMessageIdRef.current = null;
        setIsProcessing(false);
        break;

      case 'agent_event':
        handleAgentEvent(msg.event);
        break;

      case 'error':
        if (msg.messageId && activeMessageIdRef.current === msg.messageId) {
          // Error during message processing
          setMessages(prev => [
            ...prev,
            {
              role: 'assistant',
              content: `Error: ${msg.error}`,
              timestamp: new Date().toISOString(),
            },
          ]);
          setStreamingContent('');
          setStreamingToolCalls([]);
          streamAccumulatorRef.current = '';
          activeMessageIdRef.current = null;
          setIsProcessing(false);
        }
        break;

      case 'pong':
        break;
    }
  }, []);

  function applyStateSnapshot(state: AppState) {
    setMessages(state.messages);
    setWorkers(state.workers);
    setPhase(state.phase);
    setIsProcessing(state.isProcessing);
    setReasoning(state.reasoning);
    setLlmStats(state.llmStats);
    setConfig(state.config);
  }

  function handleAgentEvent(event: SerializedAgentEvent) {
    switch (event.type) {
      case 'thinking':
        setReasoning(event.content);
        break;
      case 'phase_change':
        setPhase(event.phase);
        break;
      case 'worker_spawned':
        // State will be updated via worker_update
        break;
      case 'worker_completed':
        // State will be updated via worker_update
        break;
      case 'worker_update':
        setWorkers(event.workers);
        break;
      case 'stats_update':
        setLlmStats(event.llmStats);
        break;
      case 'replan_triggered':
        // Phase change to 'replanning' is handled via the separate phase_change event,
        // but we also mark cancelled workers as failed in the local state
        setWorkers(prev => prev.map(w =>
          event.cancelledTaskIds.includes(w.id)
            ? { ...w, status: 'failed' as const }
            : w
        ));
        break;
      case 'evaluation_complete':
        setReasoning(
          `Evaluation cycle ${event.cycleNumber}: ${event.pass ? 'passed' : 'failed'} (score: ${(event.score * 100).toFixed(0)}%)${event.feedback ? ` — ${event.feedback}` : ''}`
        );
        break;
      case 'error':
        // Could show as toast/notification
        break;
    }
  }

  // ─── Connection Management ────────────────────────────────────────

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectAttemptRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        handleServerMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }, [wsUrl, handleServerMessage]);

  const scheduleReconnect = useCallback(() => {
    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(1000 * Math.pow(2, attempt), 30000); // exponential backoff, max 30s
    reconnectAttemptRef.current = attempt + 1;

    reconnectTimeoutRef.current = setTimeout(() => {
      connect();
    }, delay);
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  // Ping to keep connection alive
  useEffect(() => {
    const interval = setInterval(() => {
      send({ type: 'ping' });
    }, 30000);
    return () => clearInterval(interval);
  }, [send]);

  // ─── Public API ───────────────────────────────────────────────────

  const sendMessage = useCallback((content: string) => {
    if (!content.trim() || isProcessing) return;

    const id = generateMessageId();
    activeMessageIdRef.current = id;
    streamAccumulatorRef.current = '';

    // Optimistically add user message
    const userMsg: SerializedMessage = {
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setIsProcessing(true);
    setStreamingContent('');
    setStreamingToolCalls([]);
    setReasoning(null);

    send({ type: 'send_message', id, content });
  }, [send, isProcessing]);

  const clearMessages = useCallback(() => {
    send({ type: 'clear_conversation' });
    setMessages([]);
    setWorkers([]);
    setPhase('idle');
    setReasoning(null);
    setIsProcessing(false);
    setStreamingContent('');
    setStreamingToolCalls([]);
    streamAccumulatorRef.current = '';
  }, [send]);

  return {
    messages,
    isProcessing,
    streamingContent,
    streamingToolCalls,
    workers,
    reasoning,
    phase,
    llmStats,
    connected,
    config,
    sendMessage,
    clearMessages,
  };
}
