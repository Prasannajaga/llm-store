import type { MessageAgentToolTrace, MessageContextPayload } from '../../types';
import type { LayerProgressStep } from '../../hooks/useStreaming';
import { DISPLAYABLE_TOOLS } from '../chat/agentProgressUtils';

export type AgentActivityStatus =
    | 'success'
    | 'failed'
    | 'denied'
    | 'timed_out'
    | 'interrupted'
    | 'running'
    | 'pending';

export interface AgentActivityItem {
    id: string;
    step: number;
    tool: string;
    label: string;
    target: string | null;
    summary: string;
    status: AgentActivityStatus;
}

export interface AgentActivityViewModel {
    toolCallsTotal: number;
    approvalsRequired: number;
    approvalsDenied: number;
    timedOut: boolean;
    items: AgentActivityItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function clipText(value: string, maxChars: number): string {
    if (maxChars <= 0) return '';
    if (value.length <= maxChars) return value;
    return `${value.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function parseContextPayload(raw: string): MessageContextPayload | null {
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!isRecord(parsed)) return null;
        return parsed as MessageContextPayload;
    } catch {
        return null;
    }
}

function toolLabel(tool: string): string {
    switch (tool) {
        case 'fs.read': return 'Read file';
        case 'fs.write': return 'Write file';
        case 'fs.list': return 'List directory';
        case 'fs.delete': return 'Delete file';
        case 'shell.exec': return 'Run command';
        case 'knowledge.search': return 'Search knowledge';
        default: return 'Tool action';
    }
}

function readStringArg(args: unknown, key: string): string | null {
    if (!isRecord(args)) return null;
    const value = args[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function inferTarget(tool: string, args: unknown): string | null {
    const path = readStringArg(args, 'path');
    const command = readStringArg(args, 'command');
    const query = readStringArg(args, 'query');

    if (tool === 'shell.exec') return command ? clipText(command, 120) : null;
    if (tool === 'knowledge.search') return query ? clipText(query, 120) : null;
    if (path) return clipText(path, 120);
    if (command) return clipText(command, 120);
    if (query) return clipText(query, 120);
    return null;
}

function deriveStatus(call: MessageAgentToolTrace): AgentActivityStatus {
    if (call.interrupted) return 'interrupted';
    if (call.timed_out) return 'timed_out';
    if (call.denied) return 'denied';

    const transitions = call.state_transitions ?? [];
    const latestState = transitions[transitions.length - 1]?.state;
    if (latestState === 'running') return 'running';
    if (latestState === 'pending') return 'pending';
    if (latestState === 'error') return 'failed';
    if (latestState === 'interrupted') return 'interrupted';
    if (call.error_raw) return 'failed';
    return 'success';
}

function toItem(call: MessageAgentToolTrace, index: number): AgentActivityItem {
    const tool = call.tool?.trim() || 'unknown';
    const step = typeof call.step === 'number' && call.step > 0 ? call.step : index + 1;
    const status = deriveStatus(call);
    const summary = call.summary?.trim() || call.output_excerpt?.trim() || 'Completed';
    const target = inferTarget(tool, call.normalized_args);

    return {
        id: call.call_id || `${tool}-${step}-${index}`,
        step,
        tool,
        label: toolLabel(tool),
        target,
        summary: clipText(summary, 140),
        status,
    };
}

function liveStepToActivityStatus(step: LayerProgressStep): AgentActivityStatus {
    if (step.status === 'failed') return 'failed';
    if (step.status === 'fallback') return 'success';
    if (step.status === 'success') return 'success';
    return 'running';
}

function convertLiveStepsToItems(liveSteps: LayerProgressStep[]): AgentActivityItem[] {
    const toolSteps = liveSteps.filter(
        (s) => s.tool != null && DISPLAYABLE_TOOLS.has(s.tool),
    );

    return toolSteps.map((step, index) => ({
        id: step.callId || `live-${step.key}`,
        step: step.step ?? index + 1,
        tool: step.tool ?? 'unknown',
        label: toolLabel(step.tool ?? 'unknown'),
        target: step.displayTarget ? clipText(step.displayTarget, 120) : null,
        summary: step.message,
        status: liveStepToActivityStatus(step),
    }));
}

export function extractAgentActivity(
    contextPayloadRaw: string | null | undefined,
    liveSteps?: LayerProgressStep[],
): AgentActivityViewModel | null {
    const raw = contextPayloadRaw?.trim();

    // Try persisted context_payload first
    if (raw) {
        const payload = parseContextPayload(raw);
        const toolCalls = payload?.agent?.trace?.tool_calls ?? [];
        if (toolCalls.length > 0) {
            const items = toolCalls
                .map((call, index) => toItem(call, index))
                .sort((a, b) => (a.step === b.step ? a.id.localeCompare(b.id) : a.step - b.step));

            return {
                toolCallsTotal: payload?.agent?.tool_calls_total ?? items.length,
                approvalsRequired: payload?.agent?.approvals_required ?? 0,
                approvalsDenied: payload?.agent?.approvals_denied ?? 0,
                timedOut: Boolean(payload?.agent?.timed_out),
                items,
            };
        }
    }

    // Fallback to live steps if available
    if (liveSteps && liveSteps.length > 0) {
        const items = convertLiveStepsToItems(liveSteps);
        if (items.length > 0) {
            return {
                toolCallsTotal: items.length,
                approvalsRequired: 0,
                approvalsDenied: 0,
                timedOut: false,
                items,
            };
        }
    }

    return null;
}
