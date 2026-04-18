import { memo } from 'react';
import type { LayerProgressStep } from '../../hooks/useStreaming';

interface AgentProgressRailProps {
    steps: LayerProgressStep[];
    currentStep: LayerProgressStep | null;
    isVisible: boolean;
}

const MAX_VISIBLE_STEPS = 5;

/** Inter-step stagger delay (ms). */
const STEP_STAGGER_MS = 100;

type StepCopyMap = Partial<Record<'started' | 'success' | 'fallback' | 'failed', string>>;

const LAYER_COPY: Record<string, StepCopyMap> = {
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

const TOOL_COPY: Record<string, StepCopyMap> = {
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
    const message = step.message.replace(/\.\.\.$/, '').trim();

    if (/starting pipeline/i.test(message)) {
        return 'Starting';
    }
    if (/pipeline completed/i.test(message)) {
        return 'Complete';
    }
    if (/generation cancelled/i.test(message)) {
        return 'Cancelled';
    }
    if (/analyzing next action/i.test(message)) {
        return 'Analyzing';
    }
    if (/action was denied/i.test(message)) {
        return 'Action denied';
    }
    if (/action timed out/i.test(message)) {
        return 'Action timed out';
    }
    if (/action interrupted/i.test(message)) {
        return 'Action interrupted';
    }
    if (/reading file/i.test(message)) {
        return step.status === 'success' ? 'Read files' : 'Reading files';
    }
    if (/writing file/i.test(message)) {
        return step.status === 'success' ? 'Wrote files' : 'Writing files';
    }
    if (/listing directory/i.test(message)) {
        return step.status === 'success' ? 'Listed files' : 'Listing files';
    }
    if (/searching knowledge/i.test(message) || /knowledge search/i.test(message)) {
        return step.status === 'success' ? 'Knowledge found' : 'Searching knowledge';
    }

    return message;
}

function getStepLabel(step: LayerProgressStep): string {
    const status = step.status ?? 'started';

    if (step.activityKind === 'analyzing') {
        if (status === 'failed') {
            return 'Analysis failed';
        }
        if (status === 'fallback') {
            return 'Analysis fallback';
        }
        return 'Analyzing';
    }

    if (step.tool) {
        const mapped = TOOL_COPY[step.tool]?.[status];
        if (mapped) {
            return mapped;
        }
    }

    if (step.layer) {
        const mapped = LAYER_COPY[step.layer]?.[status];
        if (mapped) {
            return mapped;
        }
    }

    return fallbackLabel(step);
}

/* ------------------------------------------------------------------ */
/*  Inline SVG Icons (10×10, stroke-based)                            */
/* ------------------------------------------------------------------ */

const SVG_PROPS = {
    xmlns: 'http://www.w3.org/2000/svg',
    width: 10,
    height: 10,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
};

function IconFile() {
    return (
        <svg {...SVG_PROPS}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
        </svg>
    );
}

function IconPencil() {
    return (
        <svg {...SVG_PROPS}>
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
    );
}

function IconTrash() {
    return (
        <svg {...SVG_PROPS}>
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        </svg>
    );
}

function IconTerminal() {
    return (
        <svg {...SVG_PROPS}>
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
    );
}

function IconSearch() {
    return (
        <svg {...SVG_PROPS}>
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
    );
}

function IconSparkle() {
    return (
        <svg {...SVG_PROPS}>
            <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
        </svg>
    );
}

function IconGear() {
    return (
        <svg {...SVG_PROPS}>
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
    );
}

function IconDot() {
    return (
        <svg {...SVG_PROPS}>
            <circle cx="12" cy="12" r="4" />
        </svg>
    );
}

function getStepIcon(step: LayerProgressStep) {
    if (step.activityKind === 'analyzing') {
        return <IconSparkle />;
    }
    if (step.tool) {
        switch (step.tool) {
            case 'fs.read':
            case 'fs.list':
                return <IconFile />;
            case 'fs.write':
                return <IconPencil />;
            case 'fs.delete':
                return <IconTrash />;
            case 'shell.exec':
                return <IconTerminal />;
            case 'knowledge.search':
                return <IconSearch />;
        }
    }
    if (step.activityKind === 'layer') {
        return <IconGear />;
    }
    return <IconDot />;
}

/* ------------------------------------------------------------------ */
/*  Visual helpers                                                     */
/* ------------------------------------------------------------------ */

function getIconClass(step: LayerProgressStep, isActive: boolean): string {
    if (step.status === 'failed') {
        return 'text-rose-400/80';
    }
    if (step.status === 'fallback') {
        return 'text-amber-300/70';
    }
    if (step.status === 'success') {
        return 'text-neutral-500';
    }
    return isActive ? 'text-neutral-300 progress-dot-breathe' : 'text-neutral-600';
}

function getTextClass(step: LayerProgressStep, isActive: boolean): string {
    if (step.status === 'failed') {
        return 'text-rose-300/90';
    }
    if (step.status === 'fallback') {
        return 'text-amber-200/80';
    }
    if (step.status === 'success') {
        return 'text-neutral-500';
    }
    return isActive ? 'text-neutral-200' : 'text-neutral-500';
}

function getTrailClass(step: LayerProgressStep): string {
    if (step.status === 'failed') {
        return 'bg-rose-500/15';
    }
    if (step.status === 'fallback') {
        return 'bg-amber-400/10';
    }
    return 'bg-neutral-700/40';
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const AgentProgressRail = memo(function AgentProgressRail({
    steps,
    currentStep,
    isVisible,
}: AgentProgressRailProps) {
    const shouldRender = steps.length > 0 && (isVisible || currentStep !== null);
    if (!shouldRender) {
        return null;
    }

    const visibleSteps = steps.slice(-MAX_VISIBLE_STEPS);
    const currentKey = currentStep?.key ?? visibleSteps[visibleSteps.length - 1]?.key ?? null;

    return (
        <div
            className={`mx-auto w-full max-w-3xl px-4 pb-2 transition-opacity duration-200 motion-reduce:transition-none ${
                isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
        >
            <div aria-live="polite" aria-label="Agent progress" className="pl-1">
                <div className="mb-2 text-[10px] uppercase tracking-[0.22em] text-neutral-600">
                    Agent
                </div>
                <ol className="space-y-0.5">
                    {visibleSteps.map((step, index) => {
                        const isActive = step.key === currentKey;
                        const isLast = index === visibleSteps.length - 1;
                        const label = getStepLabel(step);

                        return (
                            <li
                                key={step.key}
                                style={{ animationDelay: `${index * STEP_STAGGER_MS}ms` }}
                                className="progress-step-enter flex items-start gap-2"
                            >
                                {/* Icon + trail */}
                                <div className="relative flex flex-col items-center w-[10px] shrink-0">
                                    <span className={`mt-[7px] ${getIconClass(step, isActive)}`}>
                                        {getStepIcon(step)}
                                    </span>
                                    {!isLast ? (
                                        <span className={`mt-0.5 w-px flex-1 ${getTrailClass(step)}`} style={{ minHeight: 6 }} />
                                    ) : null}
                                </div>

                                {/* Label + target */}
                                <span className={`text-[13px] leading-6 tracking-[0.01em] ${getTextClass(step, isActive)}`}>
                                    {label}
                                    {step.displayTarget ? (
                                        <span className="ml-1.5 text-[10px] text-neutral-600">{step.displayTarget}</span>
                                    ) : null}
                                </span>
                            </li>
                        );
                    })}
                </ol>
            </div>
        </div>
    );
});
