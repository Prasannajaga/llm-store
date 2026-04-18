import { memo, useState, useCallback, useEffect } from 'react';
import type { LayerProgressStep } from '../../hooks/useStreaming';
import {
    getStepLabel,
    getStepStatusColor,
    isDisplayableStep,
    ChevronIcon,
} from './agentProgressUtils';

interface AgentProgressRailProps {
    steps: LayerProgressStep[];
    currentStep: LayerProgressStep | null;
    isVisible: boolean;
    isComplete: boolean;
}

const STEP_STAGGER_MS = 60;

function StatusDot({ step, isActive }: { step: LayerProgressStep; isActive: boolean }) {
    const color = getStepStatusColor(step, isActive);
    const isRunning = isActive
        && step.status !== 'success'
        && step.status !== 'failed'
        && step.status !== 'fallback';

    return (
        <span
            className={`agent-status-dot ${isRunning ? 'agent-status-dot--active' : ''}`}
            style={{ backgroundColor: color }}
        />
    );
}

function StepRow({
    step,
    isActive,
    isExpanded,
    onToggle,
    animationDelay,
}: {
    step: LayerProgressStep;
    isActive: boolean;
    isExpanded: boolean;
    onToggle: () => void;
    animationDelay: number;
}) {
    const label = getStepLabel(step);
    const hasDetail = Boolean(step.displayTarget);

    return (
        <li
            className="progress-step-enter"
            style={{ animationDelay: `${animationDelay}ms` }}
        >
            <button
                type="button"
                className="agent-step-row"
                onClick={hasDetail ? onToggle : undefined}
                aria-expanded={hasDetail ? isExpanded : undefined}
                tabIndex={hasDetail ? 0 : -1}
                style={{ cursor: hasDetail ? 'pointer' : 'default' }}
            >
                <StatusDot step={step} isActive={isActive} />
                <span className={`agent-step-label ${isActive ? 'agent-step-label--active' : ''}`}>
                    {label}
                </span>
                {step.displayTarget ? (
                    <span className="agent-step-target">{step.displayTarget}</span>
                ) : null}
                {hasDetail ? <ChevronIcon expanded={isExpanded} /> : null}
            </button>

            {/* Expandable detail panel */}
            <div className={`agent-step-detail ${isExpanded ? 'agent-step-detail--open' : ''}`}>
                {isExpanded && step.displayTarget ? (
                    <code className="agent-step-detail-code">{step.displayTarget}</code>
                ) : null}
            </div>
        </li>
    );
}

export const AgentProgressRail = memo(function AgentProgressRail({
    steps,
    currentStep,
    isVisible,
    isComplete,
}: AgentProgressRailProps) {
    const [expandedKey, setExpandedKey] = useState<number | null>(null);
    const [isCollapsed, setIsCollapsed] = useState(false);

    // Gap 3: auto-collapse when streaming completes
    useEffect(() => {
        if (isComplete) {
            setIsCollapsed(true);
        }
    }, [isComplete]);

    const handleToggleStep = useCallback((key: number) => {
        setExpandedKey((prev) => (prev === key ? null : key));
    }, []);

    const handleToggleCollapse = useCallback(() => {
        setIsCollapsed((prev) => !prev);
    }, []);

    // Gap 2: filter out internal pipeline noise — only show user-meaningful steps
    const displayableSteps = steps.filter(isDisplayableStep);

    const shouldRender = displayableSteps.length > 0 && (isVisible || currentStep !== null);
    if (!shouldRender) return null;

    const currentKey = currentStep?.key ?? displayableSteps[displayableSteps.length - 1]?.key ?? null;
    const completedCount = displayableSteps.filter(
        (s) => s.status === 'success' || s.status === 'fallback',
    ).length;

    return (
        <div
            className={`agent-progress-rail ${isVisible ? '' : 'agent-progress-rail--hidden'}`}
            aria-live="polite"
            aria-label="Agent progress"
        >
            {/* Header */}
            <button
                type="button"
                className="agent-progress-header"
                onClick={handleToggleCollapse}
                aria-expanded={!isCollapsed}
            >
                <span className="agent-progress-header-dot" />
                <span className="agent-progress-header-label">
                    Agent · {completedCount}/{displayableSteps.length} steps
                </span>
                <ChevronIcon expanded={!isCollapsed} />
            </button>

            {/* Step list */}
            <div className={`agent-progress-body ${isCollapsed ? 'agent-progress-body--collapsed' : ''}`}>
                <ol className="agent-step-list">
                    {displayableSteps.map((step, index) => (
                        <StepRow
                            key={step.key}
                            step={step}
                            isActive={step.key === currentKey}
                            isExpanded={expandedKey === step.key}
                            onToggle={() => handleToggleStep(step.key)}
                            animationDelay={index * STEP_STAGGER_MS}
                        />
                    ))}
                </ol>
            </div>
        </div>
    );
});
