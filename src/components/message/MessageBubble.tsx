import { useState, memo, lazy, Suspense } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { Bot, User } from 'lucide-react';
import { MessageActions } from './MessageActions';
import type { Message, FeedbackRating } from '../../types';

const MarkdownRenderer = lazy(async () => {
    const mod = await import('./MarkdownRenderer');
    return { default: mod.MarkdownRenderer };
});

interface MessageBubbleProps {
    message: Message | { id: string; role: 'assistant'; content: string };
    isStreaming?: boolean;
    isThinking?: boolean;
    thinkingContent?: string;
    progressLabel?: string | null;
    progressVisible?: boolean;
    progressSteps?: Array<{
        message: string;
        status?: 'started' | 'success' | 'fallback' | 'failed';
        layer?: string;
        key: number;
    }>;
    tokensPerSecond?: number | null;
    onSaveEdit?: (id: string, newContent: string) => void;
    onFeedback?: (messageId: string, rating: FeedbackRating) => void;
    currentFeedback?: FeedbackRating | null;
}

export const MessageBubble = memo(function MessageBubble({
    message,
    isStreaming = false,
    isThinking = false,
    thinkingContent = '',
    progressLabel = null,
    progressVisible = false,
    progressSteps = [],
    tokensPerSecond = null,
    onSaveEdit,
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
    const fallbackStep = progressLabel
        ? [{
            message: progressLabel,
            status: 'started' as const,
            layer: undefined,
            key: -1,
        }]
        : [];
    const planSteps = progressSteps.length > 0 ? progressSteps : fallbackStep;
    const shouldShowPlan = isStreaming && !hasStreamText && planSteps.length > 0 && !showThinkingOnly;

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
        <div className={`py-4 w-full group ${!isUser ? 'hover:bg-neutral-900/20 transition-colors' : ''}`}>
            <div className={`max-w-4xl mx-auto flex gap-3 md:gap-4 px-4 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                <div className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-full ${isUser ? 'bg-neutral-700 outline outline-1 outline-neutral-500/80' : 'bg-brand-600'}`}>
                    {isUser ? <User size={18} className="text-white" /> : <Bot size={18} className="text-white" />}
                </div>

                <div className={`flex-1 space-y-2 min-w-0 font-sans text-neutral-200 ${isUser ? 'flex flex-col items-end' : ''}`}>
                    {isEditing ? (
                        <div className="w-full bg-neutral-800 rounded-xl p-3 border border-neutral-700 shadow-lg">
                            <TextareaAutosize
                                value={editContent}
                                onChange={(e) => setEditContent(e.target.value)}
                                minRows={2}
                                className="w-full bg-transparent text-white focus:outline-none resize-none"
                                autoFocus
                            />
                            <div className="flex justify-end gap-2 mt-3">
                                <button
                                    onClick={handleCancel}
                                    className="px-3 py-1.5 text-sm rounded bg-neutral-700 hover:bg-neutral-600 text-white transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    className="px-3 py-1.5 text-sm rounded bg-brand-600 hover:bg-brand-500 text-white transition-colors"
                                    disabled={!editContent.trim()}
                                >
                                    Save
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            {shouldShowPlan ? (
                                <div
                                    className={`flex flex-col gap-1.5 text-sm leading-6 pt-1 transition-opacity duration-200 ${
                                        progressVisible ? 'opacity-100' : 'opacity-75'
                                    }`}
                                >
                                    {planSteps.map((step, index) => {
                                        const isLatest = index === planSteps.length - 1;
                                        const isSuccess = step.status === 'success' || step.status === 'fallback';
                                        const isFailed = step.status === 'failed';
                                        return (
                                            <div
                                                key={`${step.layer ?? 'layer'}-${step.key}-${index}`}
                                                className={`flex items-center gap-2 animate-[slide-up_0.18s_ease-out] ${
                                                    isLatest ? 'text-neutral-200' : 'text-neutral-400'
                                                }`}
                                            >
                                                <span
                                                    className={`h-1.5 w-1.5 rounded-full ${
                                                        isFailed
                                                            ? 'bg-red-400'
                                                            : isSuccess
                                                                ? 'bg-emerald-400'
                                                                : 'bg-sky-400 animate-pulse'
                                                    }`}
                                                />
                                                <span>{step.message}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : showThinkingOnly ? (
                                <div className="pt-1 animate-[slide-up_0.18s_ease-out]">
                                    <div className="inline-flex items-center gap-2 text-sm text-neutral-300">
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
                                        <details className="text-xs text-neutral-500 -mb-1">
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
                                            ? 'bg-neutral-800/95 border border-neutral-700/70 px-5 py-3 rounded-2xl md:rounded-3xl max-w-[82%] shadow-sm'
                                            : 'px-0'
                                    }`}>
                                        {isStreaming || isUser ? (
                                            <pre className="whitespace-pre-wrap font-sans text-neutral-200 leading-relaxed m-0 bg-transparent">
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
        </div>
    );
});
