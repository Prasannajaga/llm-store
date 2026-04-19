import { memo, useMemo, useState, useCallback } from 'react';
import { extractAgentActivity, type AgentActivityStatus } from './agentActivity';
import type { LayerProgressStep } from '../../hooks/useStreaming';
import { ChevronIcon } from '../chat/agentProgressUtils';

interface AgentActivityPanelProps {
    contextPayloadRaw?: string | null;
    liveProgressSteps?: LayerProgressStep[];
}

/**
 * Post-completion agent activity accordion.
 *
 * Renders as:
 *   ▸ Used 3 tools           (collapsed — default)
 *   ▾ Used 3 tools           (expanded)
 *       ▸ Read file    src/main.tsx
 *       $ Run command  npm test
 *       ▸ Read file    package.json
 *
 * Clicking a tool row expands it to show the full target path + summary.
 */

function toolIcon(tool: string): string {
    switch (tool) {
        case 'fs.read': return '▸';
        case 'fs.write': return '▹';
        case 'fs.list': return '⋯';
        case 'fs.delete': return '×';
        case 'shell.exec': return '$';
        case 'knowledge.search': return '⌕';
        default: return '·';
    }
}

function statusClass(status: AgentActivityStatus): string {
    switch (status) {
        case 'failed':
        case 'denied':
            return 'aap__item--fail';
        case 'timed_out':
        case 'interrupted':
            return 'aap__item--warn';
        case 'running':
            return 'aap__item--running';
        default:
            return '';
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

    const [isOpen, setIsOpen] = useState(false);
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

    const noun = activity.toolCallsTotal === 1 ? 'tool' : 'tools';

    return (
        <div className="aap">
            {/* Panel header */}
            <button
                type="button"
                className="aap__header"
                onClick={handleTogglePanel}
                aria-expanded={isOpen}
            >
                <ChevronIcon expanded={isOpen} size={10} />
                <span>Used {activity.toolCallsTotal} {noun}</span>
            </button>

            {/* Expandable item list */}
            <div className={`aap__body ${isOpen ? 'aap__body--open' : ''}`}>
                {activity.items.map((item) => {
                    const isItemOpen = expandedId === item.id;
                    const hasDetail = Boolean(item.target) || Boolean(item.summary);

                    return (
                        <div key={item.id} className={`aap__item ${statusClass(item.status)}`}>
                            <button
                                type="button"
                                className="aap__item-row"
                                onClick={hasDetail ? () => handleToggleItem(item.id) : undefined}
                                tabIndex={hasDetail ? 0 : -1}
                                style={{ cursor: hasDetail ? 'pointer' : 'default' }}
                            >
                                <span className="aap__icon">{toolIcon(item.tool)}</span>
                                <span className="aap__item-label">{item.label}</span>
                                {item.target ? (
                                    <span className="aap__item-target">{item.target}</span>
                                ) : null}
                                {hasDetail ? <ChevronIcon expanded={isItemOpen} size={10} /> : null}
                            </button>

                            {isItemOpen ? (
                                <div className="aap__detail">
                                    {item.target ? (
                                        <code className="aap__detail-code">{item.target}</code>
                                    ) : null}
                                    {item.summary ? (
                                        <p className="aap__detail-summary">{item.summary}</p>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
});
