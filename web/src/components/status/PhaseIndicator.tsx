import type { AgentPhase } from '../../lib/protocol';

interface PhaseIndicatorProps {
  phase: AgentPhase;
  reasoning?: string | null;
}

const PHASES: { key: AgentPhase; label: string }[] = [
  { key: 'planning', label: 'Planning' },
  { key: 'executing', label: 'Executing' },
  { key: 'verifying', label: 'Verifying' },
  { key: 'replanning', label: 'Replanning' },
  { key: 'aggregating', label: 'Aggregating' },
  { key: 'evaluating', label: 'Evaluating' },
];

const PHASE_ORDER: Record<AgentPhase, number> = {
  idle: -1,
  planning: 0,
  executing: 1,
  verifying: 2,
  replanning: 3,
  aggregating: 4,
  evaluating: 5,
};

export default function PhaseIndicator({ phase, reasoning }: PhaseIndicatorProps) {
  if (phase === 'idle') return null;

  const currentIndex = PHASE_ORDER[phase];

  return (
    <div className="px-5 py-2.5 border-b border-border bg-surface-1/50 animate-fade-in-up">
      <div className="flex items-center gap-1">
        {PHASES.map((p, i) => {
          const isActive = i === currentIndex;
          const isCompleted = i < currentIndex;
          const isFuture = i > currentIndex;

          return (
            <div key={p.key} className="flex items-center">
              {/* Phase node */}
              <div
                className={`
                  flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono transition-all duration-300
                  ${isActive && (p.key === 'replanning' || p.key === 'evaluating') ? 'bg-accent-amber/15 text-accent-amber border border-accent-amber/30' : ''}
                  ${isActive && p.key !== 'replanning' && p.key !== 'evaluating' ? 'bg-accent-teal/15 text-accent-teal border border-accent-teal/30' : ''}
                  ${isCompleted ? 'text-accent-green' : ''}
                  ${isFuture ? 'text-text-muted/40' : ''}
                `}
              >
                {isCompleted && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {isActive && (p.key === 'replanning' || p.key === 'evaluating') && (
                  <div className="w-1.5 h-1.5 rounded-full bg-accent-amber animate-pulse-soft" />
                )}
                {isActive && p.key !== 'replanning' && p.key !== 'evaluating' && (
                  <div className="w-1.5 h-1.5 rounded-full bg-accent-teal animate-pulse-soft" />
                )}
                {p.label}
              </div>

              {/* Connector line */}
              {i < PHASES.length - 1 && (
                <div
                  className={`
                    w-6 h-px mx-0.5 transition-colors duration-300
                    ${i < currentIndex ? 'bg-accent-green/40' : 'bg-border'}
                  `}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Reasoning text */}
      {reasoning && (
        <p className="mt-1.5 text-xs font-mono text-text-muted truncate max-w-2xl pl-0.5">
          {reasoning}
        </p>
      )}
    </div>
  );
}
