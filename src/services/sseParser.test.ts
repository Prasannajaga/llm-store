import { describe, expect, it } from 'vitest';
import { extractSsePayloads } from './sseParser';

describe('extractSsePayloads', () => {
    it('keeps incomplete payloads in remainder until complete', () => {
        const first = extractSsePayloads('data: {"content":"hel');
        expect(first.payloads).toEqual([]);
        expect(first.remainder).toBe('data: {"content":"hel');

        const second = extractSsePayloads(`${first.remainder}lo"}\n\n`);
        expect(second.payloads).toEqual(['{"content":"hello"}']);
        expect(second.remainder).toBe('');
    });

    it('extracts multiple payloads and leaves trailing remainder', () => {
        const result = extractSsePayloads('data: one\n\ndata: two\n\ndata: thr');
        expect(result.payloads).toEqual(['one', 'two']);
        expect(result.remainder).toBe('data: thr');
    });

    it('joins multi-line data fields into one payload', () => {
        const result = extractSsePayloads('event: message\ndata: line1\ndata: line2\n\n');
        expect(result.payloads).toEqual(['line1\nline2']);
        expect(result.remainder).toBe('');
    });
});
