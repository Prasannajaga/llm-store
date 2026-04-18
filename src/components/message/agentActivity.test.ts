import { describe, expect, it } from 'vitest';
import { extractAgentActivity } from './agentActivity';

describe('extractAgentActivity', () => {
    it('returns null for missing payload', () => {
        expect(extractAgentActivity(null)).toBeNull();
        expect(extractAgentActivity('')).toBeNull();
    });

    it('extracts persisted tool timeline with targets and statuses', () => {
        const payload = JSON.stringify({
            agent: {
                tool_calls_total: 2,
                approvals_required: 1,
                approvals_denied: 0,
                timed_out: true,
                trace: {
                    tool_calls: [
                        {
                            call_id: 'call-1',
                            step: 1,
                            tool: 'fs.read',
                            normalized_args: { path: '/tmp/cli.txt' },
                            state_transitions: [
                                { state: 'pending', at: '2026-01-01T00:00:00Z' },
                                { state: 'running', at: '2026-01-01T00:00:01Z' },
                                { state: 'completed', at: '2026-01-01T00:00:02Z' },
                            ],
                            summary: 'Read file successfully',
                            output_excerpt: 'Read 120 bytes',
                        },
                        {
                            call_id: 'call-2',
                            step: 2,
                            tool: 'shell.exec',
                            normalized_args: { command: 'npm test' },
                            state_transitions: [
                                { state: 'pending', at: '2026-01-01T00:00:03Z' },
                                { state: 'running', at: '2026-01-01T00:00:04Z' },
                            ],
                            summary: 'Command timed out',
                            timed_out: true,
                        },
                    ],
                },
            },
        });

        const activity = extractAgentActivity(payload);

        expect(activity).not.toBeNull();
        expect(activity?.toolCallsTotal).toBe(2);
        expect(activity?.approvalsRequired).toBe(1);
        expect(activity?.timedOut).toBe(true);
        expect(activity?.items).toHaveLength(2);
        expect(activity?.items[0]).toMatchObject({
            step: 1,
            tool: 'fs.read',
            label: 'Read file',
            target: '/tmp/cli.txt',
            status: 'success',
        });
        expect(activity?.items[1]).toMatchObject({
            step: 2,
            tool: 'shell.exec',
            label: 'Run command',
            target: 'npm test',
            status: 'timed_out',
        });
    });

    it('ignores non-agent payloads safely', () => {
        const payload = JSON.stringify({
            knowledge: {
                retrieved_count: 3,
                deduped_count: 2,
                chunks: [],
            },
        });
        expect(extractAgentActivity(payload)).toBeNull();
    });
});
