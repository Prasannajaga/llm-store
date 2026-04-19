import type { LayerProgressStep } from '../../hooks/useStreaming';

type StepCopyMap = Partial<Record<'started' | 'success' | 'fallback' | 'failed', string>>;

export const LAYER_COPY: Record<string, StepCopyMap> = {
    input_normalize: {
        started: 'Checking request',
        success: 'Request ready',
        failed: 'Request failed',
    },
    retrieval_plan: {
        started: 'Planning retrieval',
        success: 'Plan ready',
        fallback: 'Using fallback plan',
        failed: 'Planning failed',
    },
    rag_query: {
        started: 'Finding context',
        success: 'Context found',
        fallback: 'Continuing without context',
        failed: 'Context lookup failed',
    },
    dedupe_context: {
        started: 'Sorting context',
        success: 'Context sorted',
        fallback: 'Using raw context',
        failed: 'Context step failed',
    },
    prompt_build: {
        started: 'Preparing answer',
        success: 'Prompt ready',
        fallback: 'Using minimal prompt',
        failed: 'Prompt step failed',
    },
    agent_loop: {
        started: 'Running agent',
        success: 'Agent done',
        fallback: 'Agent used fallback',
        failed: 'Agent failed',
    },
    llm_invoke_stream: {
        started: 'Writing response',
        success: 'Response ready',
        failed: 'Generation failed',
    },
    persist_messages: {
        started: 'Saving response',
        success: 'Saved',
        fallback: 'Saved with fallback',
        failed: 'Save failed',
    },
};

export const TOOL_COPY: Record<string, StepCopyMap> = {
    'fs.read': {
        started: 'Reading files',
        success: 'Read files',
        failed: 'Read failed',
    },
    'fs.write': {
        started: 'Writing files',
        success: 'Wrote files',
        fallback: 'Write skipped',
        failed: 'Write failed',
    },
    'fs.list': {
        started: 'Listing files',
        success: 'Listed files',
        failed: 'List failed',
    },
    'fs.delete': {
        started: 'Removing files',
        success: 'Removed files',
        fallback: 'Delete skipped',
        failed: 'Delete failed',
    },
    'shell.exec': {
        started: 'Running command',
        success: 'Command done',
        fallback: 'Command skipped',
        failed: 'Command failed',
    },
    'knowledge.search': {
        started: 'Searching knowledge',
        success: 'Knowledge found',
        fallback: 'Knowledge fallback',
        failed: 'Search failed',
    },
};

function fallbackLabel(step: LayerProgressStep): string {
    const message = step.message.replace(/\.\.\.$/u, '').trim();

    if (/starting pipeline/iu.test(message)) return 'Starting';
    if (/pipeline completed/iu.test(message)) return 'Complete';
    if (/generation cancelled/iu.test(message)) return 'Cancelled';
    if (/analyzing next action/iu.test(message)) return 'Analyzing';
    if (/action was denied/iu.test(message)) return 'Action denied';
    if (/action timed out/iu.test(message)) return 'Action timed out';
    if (/action interrupted/iu.test(message)) return 'Action interrupted';
    if (/reading file/iu.test(message)) return step.status === 'success' ? 'Read files' : 'Reading files';
    if (/writing file/iu.test(message)) return step.status === 'success' ? 'Wrote files' : 'Writing files';
    if (/listing directory/iu.test(message)) return step.status === 'success' ? 'Listed files' : 'Listing files';
    if (/searching knowledge|knowledge search/iu.test(message)) return step.status === 'success' ? 'Knowledge found' : 'Searching knowledge';

    return message;
}

export function getStepLabel(step: LayerProgressStep): string {
    const status = step.status ?? 'started';

    if (step.activityKind === 'analyzing') {
        if (status === 'failed') return 'Analysis failed';
        if (status === 'fallback') return 'Analysis fallback';
        return 'Analyzing';
    }

    if (step.tool) {
        const mapped = TOOL_COPY[step.tool]?.[status];
        if (mapped) return mapped;
    }

    if (step.layer) {
        const mapped = LAYER_COPY[step.layer]?.[status];
        if (mapped) return mapped;
    }

    return fallbackLabel(step);
}

export function getStepStatusColor(step: LayerProgressStep, isActive: boolean): string {
    if (step.status === 'failed') return 'var(--agent-fail)';
    if (step.status === 'fallback') return 'var(--agent-warn)';
    if (step.status === 'success') return 'var(--agent-fg-muted)';
    return isActive ? 'var(--agent-fg-active)' : 'var(--agent-fg-muted)';
}

/** Tools that produce user-visible steps worth showing in the progress rail. */
export const DISPLAYABLE_TOOLS = new Set([
    'fs.read',
    'fs.write',
    'fs.list',
    'fs.delete',
    'shell.exec',
    'knowledge.search',
]);

/**
 * Only show steps that are meaningful to the user:
 * - Any tool call
 * - Agent-loop analysis
 * - LLM stream start/end
 * - Any failure (always surface errors)
 */
export function isDisplayableStep(step: LayerProgressStep): boolean {
    if (step.status === 'failed') return true;
    if (step.activityKind === 'tool' || (step.tool && DISPLAYABLE_TOOLS.has(step.tool))) return true;
    if (step.activityKind === 'analyzing') return true;
    if (step.layer === 'agent_loop' || step.layer === 'llm_invoke_stream') return true;
    return false;
}

/** Shared chevron SVG used in both the live rail and post-completion panel. */
export function ChevronIcon({ expanded, size = 12 }: { expanded: boolean; size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`agent-chevron ${expanded ? 'agent-chevron--open' : ''}`}
        >
            <polyline points="6 9 12 15 18 9" />
        </svg>
    );
}

