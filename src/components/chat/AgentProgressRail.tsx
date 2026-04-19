import { memo, useState, useCallback, useEffect } from 'react';
import type { LayerProgressStep } from '../../hooks/useStreaming';
import {
    getStepLabel,
    isDisplayableStep,
    ChevronIcon,
} from './agentProgressUtils';

interface AgentProgressRailProps {
    steps: LayerProgressStep[];
    currentStep: LayerProgressStep | null;
    isVisible: boolean;
    isComplete: boolean;
}

/**
 * Inline agent progress — sits inside the streaming area.
 *
 * Design: a clean stack of action rows. Each row is simply:
 *   ● Label .............. target
 * Active row pulses. Completed rows dim. The whole thing auto-collapses
 * into a single-line summary once generation finishes.
 */
export const AgentProgressRail = memo(function AgentProgressRail({
    steps,
    currentStep,
    isVisible,
    isComplete,
}: AgentProgressRailProps) {
    const [isCollapsed, setIsCollapsed] = useState(false);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (isComplete) setIsCollapsed(true);
    }, [isComplete]);

    const handleToggleCollapse = useCallback(() => {
        setIsCollapsed((prev) => !prev);
    }, []);

    const displayableSteps = steps.filter(isDisplayableStep);

    const shouldRender = displayableSteps.length > 0 && (isVisible || currentStep !== null);
    if (!shouldRender) return null;

    const currentKey = currentStep?.key ?? displayableSteps[displayableSteps.length - 1]?.key ?? null;
    const completedCount = displayableSteps.filter(
        (s) => s.status === 'success' || s.status === 'fallback',
    ).length;
    const totalCount = displayableSteps.length;

    // Current action for header
    const currentLabel = currentStep
        ? getStepLabel(currentStep)
        : (completedCount === totalCount ? 'Done' : 'Working…');

    return (
        <div
            className={`apr ${isVisible ? '' : 'apr--hidden'}`}
            aria-live="polite"
            aria-label="Agent progress"
        >
            {/* Single-line header */}
            <button
                type="button"
                className="apr__header"
                onClick={handleToggleCollapse}
                aria-expanded={!isCollapsed}
            >
                <span className="apr__indicator" />
                <span className="apr__label">{currentLabel}</span>
                <span className="apr__count">{completedCount}/{totalCount}</span>
                <ChevronIcon expanded={!isCollapsed} size={10} />
            </button>

            {/* Collapsed body */}
            <div className={`apr__body ${isCollapsed ? 'apr__body--closed' : ''}`}>
                {displayableSteps.map((step) => {
                    const isActive = step.key === currentKey;
                    const isDone = step.status === 'success' || step.status === 'fallback';
                    const isFailed = step.status === 'failed';
                    const label = getStepLabel(step);

                    let rowClass = 'apr__row';
                    if (isActive && !isDone && !isFailed) rowClass += ' apr__row--active';
                    if (isDone) rowClass += ' apr__row--done';
                    if (isFailed) rowClass += ' apr__row--fail';

                    return (
                        <div key={step.key} className={rowClass}>
                            <span className="apr__dot" />
                            <span className="apr__row-label">{label}</span>
                            {step.displayTarget ? (
                                <span className="apr__target">{step.displayTarget}</span>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
});
