import { memo, useMemo } from 'react';
import { extractAgentActivity, type AgentActivityStatus } from './agentActivity';

interface AgentActivityPanelProps {
    contextPayloadRaw?: string | null;
}

const MAX_VISIBLE_ITEMS = 8;

function dotClass(status: AgentActivityStatus): string {
    switch (status) {
        case 'failed':
        case 'denied':
            return 'bg-rose-400';
        case 'timed_out':
        case 'interrupted':
            return 'bg-amber-300';
        case 'running':
            return 'bg-sky-300';
        case 'pending':
            return 'bg-neutral-500';
        case 'success':
        default:
            return 'bg-emerald-400';
    }
}

function statusLabel(status: AgentActivityStatus): string {
    switch (status) {
        case 'failed':
            return 'Failed';
        case 'denied':
            return 'Denied';
        case 'timed_out':
            return 'Timed out';
        case 'interrupted':
            return 'Interrupted';
        case 'running':
            return 'Running';
        case 'pending':
            return 'Pending';
        case 'success':
        default:
            return 'Done';
    }
}

export const AgentActivityPanel = memo(function AgentActivityPanel({
    contextPayloadRaw = null,
}: AgentActivityPanelProps) {
    const activity = useMemo(
        () => extractAgentActivity(contextPayloadRaw),
        [contextPayloadRaw],
    );

    if (!activity || activity.items.length === 0) {
        return null;
    }

    const visibleItems = activity.items.slice(-MAX_VISIBLE_ITEMS);
    const hiddenCount = Math.max(0, activity.items.length - visibleItems.length);

    return (
        <details className="mb-2 rounded-lg border border-neutral-700/60 bg-neutral-900/30 px-3 py-2">
            <summary className="cursor-pointer select-none text-xs text-neutral-300 hover:text-neutral-100 transition-colors">
                Agent activity · {activity.toolCallsTotal} action{activity.toolCallsTotal === 1 ? '' : 's'}
            </summary>

            <div className="mt-2 space-y-2">
                <div className="text-[11px] text-neutral-500">
                    Approvals: {activity.approvalsRequired} required, {activity.approvalsDenied} denied
                    {activity.timedOut ? ', timed out' : ''}
                </div>

                <ol className="space-y-1.5">
                    {visibleItems.map((item) => (
                        <li key={item.id} className="rounded border border-neutral-800/80 bg-neutral-950/30 px-2 py-1.5">
                            <div className="flex items-center gap-2 text-[12px]">
                                <span className={`h-2 w-2 rounded-full ${dotClass(item.status)}`} />
                                <span className="text-neutral-200">
                                    {item.step}. {item.label}
                                </span>
                                {item.target ? (
                                    <code className="ml-auto max-w-[60%] truncate rounded bg-neutral-800/80 px-1.5 py-0.5 text-[10px] text-neutral-300">
                                        {item.target}
                                    </code>
                                ) : null}
                            </div>
                            <div className="mt-0.5 text-[11px] text-neutral-500">
                                {statusLabel(item.status)} · {item.summary}
                            </div>
                        </li>
                    ))}
                </ol>

                {hiddenCount > 0 ? (
                    <p className="text-[11px] text-neutral-600">
                        +{hiddenCount} more action{hiddenCount === 1 ? '' : 's'}
                    </p>
                ) : null}
            </div>
        </details>
    );
});
