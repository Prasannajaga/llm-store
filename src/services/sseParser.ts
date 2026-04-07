interface SseParseResult {
    payloads: string[];
    remainder: string;
}

/**
 * Extracts complete SSE payloads from a buffered stream.
 * Incomplete trailing data is returned in `remainder` for the next chunk.
 */
export function extractSsePayloads(buffer: string): SseParseResult {
    const normalized = buffer.replace(/\r\n/g, '\n');
    const events = normalized.split('\n\n');
    const remainder = events.pop() ?? '';
    const payloads: string[] = [];

    for (const event of events) {
        const lines = event.split('\n');
        const dataLines: string[] = [];
        for (const line of lines) {
            if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trimStart());
            }
        }
        if (dataLines.length > 0) {
            payloads.push(dataLines.join('\n'));
        }
    }

    return { payloads, remainder };
}
