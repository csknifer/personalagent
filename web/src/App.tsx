import { useQueenSocket } from './hooks/useQueenSocket';
import Header from './components/layout/Header';
import PhaseIndicator from './components/status/PhaseIndicator';
import ChatPanel from './components/chat/ChatPanel';
import WorkerPanel from './components/workers/WorkerPanel';
import StatsBar from './components/status/StatsBar';

export default function App() {
  const {
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
    discoveryState,
    sendMessage,
    clearMessages,
  } = useQueenSocket();

  return (
    <div className="h-screen flex flex-col bg-surface-0 text-text-primary">
      {/* Header */}
      <Header config={config} connected={connected} llmStats={llmStats} />

      {/* Phase indicator */}
      <PhaseIndicator phase={phase} reasoning={reasoning} />

      {/* Main content: chat + worker panel */}
      <div className="flex-1 flex min-h-0">
        {/* Chat panel */}
        <div className="flex-1 flex flex-col min-w-0">
          <ChatPanel
            messages={messages}
            streamingContent={streamingContent}
            streamingToolCalls={streamingToolCalls}
            isProcessing={isProcessing}
            onSend={sendMessage}
            onClear={clearMessages}
          />
        </div>

        {/* Worker panel — shown when workers exist */}
        <WorkerPanel workers={workers} phase={phase} llmStats={llmStats} discoveryState={discoveryState} />
      </div>

      {/* Stats bar */}
      <StatsBar llmStats={llmStats} workers={workers} />
    </div>
  );
}
