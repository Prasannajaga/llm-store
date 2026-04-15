import { useState, memo, lazy, Suspense } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { MessageActions } from './MessageActions';
import type { Message, FeedbackRating } from '../../types';
import { Button } from '../ui/Button';

const MarkdownRenderer = lazy(async () => {
    const mod = await import('./MarkdownRenderer');
    return { default: mod.MarkdownRenderer };
});

interface MessageBubbleProps {
    message: Message | { id: string; role: 'assistant'; content: string };
    isStreaming?: boolean;
    isThinking?: boolean;
    thinkingContent?: string;
    tokensPerSecond?: number | null;
    onSaveEdit?: (id: string, newContent: string) => void;
    onRegenerate?: (messageId: string) => void;
    onFeedback?: (messageId: string, rating: FeedbackRating) => void;
    currentFeedback?: FeedbackRating | null;
}

export const MessageBubble = memo(function MessageBubble({
    message,
    isStreaming = false,
    isThinking = false,
    thinkingContent = '',
    tokensPerSecond = null,
    onSaveEdit,
    onRegenerate,
    onFeedback,
    currentFeedback,
}: MessageBubbleProps) {
    const isUser = message.role === 'user';
    const isSystem = message.role === 'system';

    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState(message.content);

    if (isSystem) return null;

    const hasStreamText = message.content.trim().length > 0;
    const hasThinkingText = thinkingContent.trim().length > 0;
    const showThinkingOnly = isStreaming && !hasStreamText && (isThinking || hasThinkingText);
    const showThinkingSummary = isStreaming && hasStreamText && hasThinkingText;
    const showSavedThinking = !isStreaming && hasThinkingText;
    const showThoughtDetails = showThinkingSummary || showSavedThinking;

    const handleSave = () => {
        if (editContent.trim() && editContent !== message.content && onSaveEdit) {
            onSaveEdit(message.id, editContent);
        }
        setIsEditing(false);
    };

    const handleCancel = () => {
        setEditContent(message.content);
        setIsEditing(false);
    };

    return (
        <div className={`group w-full transition-colors ${!isUser ? 'hover:bg-[var(--surface-message-hover)]' : ''}`}>
            <div className={`max-w-3xl mx-auto px-4 py-5 ${isUser ? 'flex flex-col items-end' : ''}`}>
                {/* Role label */}
                <div className={`mb-1.5 text-xs font-semibold text-neutral-400 select-none ${isUser ? 'text-right' : ''}`}>
                    {isUser ? 'You' : 'Assistant'}
                </div>

                {isEditing ? (
                    <div className="rounded-xl bg-neutral-800/80 p-3 border border-neutral-700">
                        <TextareaAutosize
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            minRows={2}
                            className="w-full bg-transparent text-neutral-100 focus:outline-none resize-none text-[15px] leading-relaxed"
                            autoFocus
                        />
                        <div className="flex justify-end gap-2 mt-3">
                            <Button variant="secondary" size="sm" onClick={handleCancel}>
                                Cancel
                            </Button>
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={handleSave}
                                disabled={!editContent.trim()}
                            >
                                Save
                            </Button>
                        </div>
                    </div>
                ) : (
                    <>
                        {showThinkingOnly ? (
                            <div className="pt-1 animate-[slide-up_0.18s_ease-out]">
                                <div className="inline-flex items-center gap-2 text-sm text-neutral-400">
                                    <span className="inline-flex items-center gap-1">
                                        <span className="h-1.5 w-1.5 rounded-full bg-neutral-400 animate-pulse" />
                                        <span className="h-1.5 w-1.5 rounded-full bg-neutral-500 animate-pulse [animation-delay:120ms]" />
                                        <span className="h-1.5 w-1.5 rounded-full bg-neutral-600 animate-pulse [animation-delay:240ms]" />
                                    </span>
                                    <span>Thinking</span>
                                </div>
                                {hasThinkingText && (
                                    <details className="mt-2 text-xs text-neutral-500">
                                        <summary className="cursor-pointer select-none hover:text-neutral-300 transition-colors">
                                            View reasoning
                                        </summary>
                                        <pre className="whitespace-pre-wrap font-sans text-neutral-400 leading-relaxed mt-2 mb-0">
                                            {thinkingContent}
                                        </pre>
                                    </details>
                                )}
                            </div>
                        ) : (
                            <>
                                {showThoughtDetails && (
                                    <details className="text-xs text-neutral-500 mb-2">
                                        <summary className="cursor-pointer select-none hover:text-neutral-300 transition-colors">
                                            Thought process
                                        </summary>
                                        <pre className="whitespace-pre-wrap font-sans text-neutral-400 leading-relaxed mt-2 mb-0">
                                            {thinkingContent}
                                        </pre>
                                    </details>
                                )}
                                <div className={`markdown-body prose prose-invert max-w-none prose-p:leading-relaxed prose-pre:p-0 prose-headings:mb-2 prose-p:mb-3 ${
                                    isUser
                                        ? 'bg-neutral-800 border border-neutral-700/60 px-4 py-3 rounded-2xl max-w-[82%]'
                                        : ''
                                }`}>
                                    {isStreaming || isUser ? (
                                        <pre className="whitespace-pre-wrap font-sans text-neutral-200 leading-relaxed m-0 bg-transparent text-[15px]">
                                            {message.content}
                                        </pre>
                                    ) : (
                                        <Suspense fallback={<pre className="whitespace-pre-wrap font-sans text-neutral-200 leading-relaxed m-0 bg-transparent">{message.content}</pre>}>
                                            <MarkdownRenderer
                                                content={message.content}
                                                isStreaming={isStreaming}
                                            />
                                        </Suspense>
                                    )}
                                </div>

                                <MessageActions
                                    message={message}
                                    showCopy={!isStreaming}
                                    onEdit={() => {
                                        setEditContent(message.content);
                                        setIsEditing(true);
                                    }}
                                    onRegenerate={message.role === 'assistant' && !isStreaming
                                        ? () => onRegenerate?.(message.id)
                                        : undefined}
                                    onFeedback={onFeedback}
                                    currentFeedback={currentFeedback}
                                    tokensPerSecond={tokensPerSecond}
                                    isStreaming={isStreaming}
                                />
                            </>
                        )}
                    </>
                )}
            </div>
        </div>
    );
});
