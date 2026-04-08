import { Check, Copy, Edit2, ThumbsUp, ThumbsDown } from 'lucide-react';
import { useState, memo } from 'react';
import type { Message, FeedbackRating } from '../../types';

interface MessageActionsProps {
    message: Message | { id: string; role: 'assistant'; content: string };
    showCopy: boolean;
    onEdit?: () => void;
    onFeedback?: (messageId: string, rating: FeedbackRating) => void;
    currentFeedback?: FeedbackRating | null;
    tokensPerSecond?: number | null;
    isStreaming?: boolean;
}

export const MessageActions = memo(function MessageActions({
    message,
    showCopy,
    onEdit,
    onFeedback,
    currentFeedback,
    tokensPerSecond,
    isStreaming = false,
}: MessageActionsProps) {
    const [copied, setCopied] = useState(false);
    const isUser = message.role === 'user';
    const isAssistant = message.role === 'assistant';
    const showSpeedMetric = isAssistant && typeof tokensPerSecond === 'number' && Number.isFinite(tokensPerSecond) && tokensPerSecond > 0;

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(message.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy', err);
        }
    };

    return (
        <div
            className={`pt-2 flex items-center gap-2 text-neutral-500 transition-opacity ${
                showSpeedMetric ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            }`}
        >
            {showCopy && (
                <button
                    onClick={handleCopy}
                    className="p-1.5 hover:text-neutral-300 transition-colors rounded-md hover:bg-neutral-800"
                    title="Copy response"
                >
                    {copied ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
                </button>
            )}

            {isUser && onEdit && (
                <button
                    onClick={onEdit}
                    className="p-1.5 hover:text-neutral-300 transition-colors rounded-md hover:bg-neutral-800"
                    title="Edit message"
                >
                    <Edit2 size={16} />
                </button>
            )}

            {isAssistant && onFeedback && (
                <>
                    <button
                        onClick={() => onFeedback(message.id, 'good')}
                        className={`p-1.5 transition-colors rounded-md hover:bg-neutral-800 ${
                            currentFeedback === 'good'
                                ? 'text-emerald-400'
                                : 'hover:text-neutral-300'
                        }`}
                        title="Good response"
                    >
                        <ThumbsUp size={16} />
                    </button>
                    <button
                        onClick={() => onFeedback(message.id, 'bad')}
                        className={`p-1.5 transition-colors rounded-md hover:bg-neutral-800 ${
                            currentFeedback === 'bad'
                                ? 'text-red-400'
                                : 'hover:text-neutral-300'
                        }`}
                        title="Bad response"
                    >
                        <ThumbsDown size={16} />
                    </button>
                </>
            )}

            {showSpeedMetric && (
                <span
                    className={`text-[11px] leading-none px-1.5 py-0.5 rounded-md border ${
                        isStreaming
                            ? 'text-sky-300 border-sky-500/40 bg-sky-500/10'
                            : 'text-neutral-400 border-neutral-700 bg-neutral-900/50'
                    }`}
                    title="Approximate tokens per second"
                >
                    {(tokensPerSecond ?? 0).toFixed(1)} tok/s
                </span>
            )}
        </div>
    );
});
