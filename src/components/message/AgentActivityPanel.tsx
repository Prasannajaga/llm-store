import { memo, useMemo, useState, useCallback } from 'react';
import { extractAgentActivity, type AgentActivityStatus } from './agentActivity';
import type { LayerProgressStep } from '../../hooks/useStreaming';
import { ChevronIcon } from '../chat/agentProgressUtils';

interface AgentActivityPanelProps {
    contextPayloadRaw?: string | null;
    liveProgressSteps?: LayerProgressStep[];
}

function dotColor(status: AgentActivityStatus): string {
    switch (status) {
        case 'failed':
        case 'denied':
            return 'var(--progress-error)';
        case 'timed_out':
        case 'interrupted':
            return 'var(--progress-warn)';
        case 'running':
            return 'var(--progress-running)';
        case 'pending':
            return 'var(--progress-muted)';
        case 'success':
        default:
            return 'var(--progress-done)';
    }
}

export const AgentActivityPanel = memo(function AgentActivityPanel({
    contextPayloadRaw = null,
    liveProgressSteps,
}: AgentActivityPanelProps) {
    const activity = useMemo(
        () => extractAgentActivity(contextPayloadRaw, liveProgressSteps),
        [contextPayloadRaw, liveProgressSteps],
    );

    // Gap 4: open by default so context is immediately visible after completion
    const [isOpen, setIsOpen] = useState(true);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    const handleTogglePanel = useCallback(() => {
        setIsOpen((prev) => !prev);
    }, []);

    const handleToggleItem = useCallback((id: string) => {
        setExpandedId((prev) => (prev === id ? null : id));
    }, []);

    if (!activity || activity.items.length === 0) {
        return null;
    }

    return (
        <div className="agent-activity-panel">
            {/* Header */}
            <button
                type="button"
                className="agent-activity-header"
                onClick={handleTogglePanel}
                aria-expanded={isOpen}
            >
                <ChevronIcon expanded={isOpen} />
                <span>
                    Agent activity · {activity.toolCallsTotal} action{activity.toolCallsTotal === 1 ? '' : 's'}
                </span>
            </button>

            {/* Expandable body */}
            <div className={`agent-activity-body ${isOpen ? 'agent-activity-body--open' : ''}`}>
                <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {activity.items.map((item) => {
                        const isItemExpanded = expandedId === item.id;
                        const hasDetail = Boolean(item.target) || Boolean(item.summary);

                        return (
                            <li key={item.id}>
                                <div
                                    className="agent-activity-item"
                                    onClick={hasDetail ? () => handleToggleItem(item.id) : undefined}
                                    role={hasDetail ? 'button' : undefined}
                                    tabIndex={hasDetail ? 0 : undefined}
                                    onKeyDown={hasDetail ? (e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            handleToggleItem(item.id);
                                        }
                                    } : undefined}
                                >
                                    <span
                                        className="agent-activity-dot"
                                        style={{ backgroundColor: dotColor(item.status) }}
                                    />
                                    <span className="agent-activity-label">
                                        {item.step}. {item.label}
                                    </span>
                                    {item.target ? (
                                        <span className="agent-activity-target">{item.target}</span>
                                    ) : null}
                                    {hasDetail ? <ChevronIcon expanded={isItemExpanded} /> : null}
                                </div>

                                <div className={`agent-activity-item-detail ${isItemExpanded ? 'agent-activity-item-detail--open' : ''}`}>
                                    {isItemExpanded ? (
                                        <div className="agent-activity-item-detail-inner">
                                            {item.target ? <div>{item.target}</div> : null}
                                            {/* Gap 5: use CSS class instead of hardcoded color */}
                                            {item.summary ? <div className="agent-activity-summary-text">{item.summary}</div> : null}
                                        </div>
                                    ) : null}
                                </div>
                            </li>
                        );
                    })}
                </ol>
            </div>
        </div>
    );
});
