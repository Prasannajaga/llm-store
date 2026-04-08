import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useChatStore } from '../../store/chatStore';
import { useStreaming } from '../../hooks/useStreaming';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { messageService } from '../../services/messageService';
import { feedbackService } from '../../services/feedbackService';
import { knowledgeService } from '../../services/knowledgeService';
import { useSettingsStore } from '../../store/settingsStore';
import { useUiStore } from '../../store/uiStore';
import { MessageBubble } from '../message/MessageBubble';
import { ChatInput } from '../input/ChatInput';
import { ModelSelector } from '../sidebar/ModelSelector';
import type { Message, FeedbackRating, KnowledgeSearchResult } from '../../types';
import { v4 as uuidv4 } from 'uuid';
import { AlertTriangle, X } from 'lucide-react';

export function ChatArea() {
    const { activeChatId, chats } = useChatStore();
    const [messages, setMessages] = useState<Message[]>([]);
    const {
        isGenerating,
        currentStream,
        thinkingStream,
        isThinking,
        error,
        progress,
        progressSteps,
        isProgressVisible,
        liveTokensPerSecond,
        generate,
        generatePipeline,
        cancel,
        clearError,
    } = useStreaming();
    const [askError, setAskError] = useState<string | null>(null);
    const pipelineMode = useSettingsStore((s) => s.pipelineMode);
    const isSidebarOpen = useUiStore((s) => s.isSidebarOpen);
    const activeChat = useMemo(() => chats.find(c => c.id === activeChatId), [chats, activeChatId]);
    const [feedbackMap, setFeedbackMap] = useState<Record<string, FeedbackRating>>({});
    const [assistantTokensPerSecond, setAssistantTokensPerSecond] = useState<Record<string, number>>({});
    const [assistantReasoningById, setAssistantReasoningById] = useState<Record<string, string>>({});
    const GENERIC_SEND_ERROR = 'Unable to send message right now. Please try again.';
    const GENERIC_GENERATION_ERROR = 'Something went wrong while generating. Please try again.';

    // Keep a ref to the latest messages so handleFeedback never closes over stale state.
    // This allows the callback identity to remain stable (no `messages` dependency).
    const messagesRef = useRef<Message[]>(messages);
    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    const upsertAssistantTps = useCallback((messageId: string, value: number) => {
        setAssistantTokensPerSecond((prev) => {
            const next: Record<string, number> = { ...prev, [messageId]: value };
            const keys = Object.keys(next);
            const MAX_ENTRIES = 300;
            if (keys.length <= MAX_ENTRIES) {
                return next;
            }
            const trimCount = keys.length - MAX_ENTRIES;
            for (let i = 0; i < trimCount; i++) {
                delete next[keys[i]];
            }
            return next;
        });
    }, []);

    const upsertAssistantReasoning = useCallback((messageId: string, reasoningText: string) => {
        const normalized = reasoningText.trim();
        if (!normalized) {
            return;
        }
        setAssistantReasoningById((prev) => {
            const next: Record<string, string> = { ...prev, [messageId]: normalized };
            const keys = Object.keys(next);
            const MAX_ENTRIES = 300;
            if (keys.length <= MAX_ENTRIES) {
                return next;
            }
            const trimCount = keys.length - MAX_ENTRIES;
            for (let i = 0; i < trimCount; i++) {
                delete next[keys[i]];
            }
            return next;
        });
    }, []);

    // Auto-scroll hook depends on messages and both stream channels.
    // Memoized to avoid refiring the effect on unrelated re-renders.
    const autoScrollDependency = useMemo(
        () => [messages.length, currentStream, thinkingStream],
        [messages.length, currentStream, thinkingStream],
    );
    const scrollRef = useAutoScroll(autoScrollDependency);

    /** Batch-load feedback for all assistant messages in ONE backend call. */
    const loadFeedbackBatch = useCallback(async (msgs: Message[]) => {
        const assistantIds = msgs
            .filter(m => m.role === 'assistant')
            .map(m => m.id);

        if (assistantIds.length === 0) {
            setFeedbackMap({});
            return;
        }

        try {
            const feedbacks = await feedbackService.getFeedbackBatch(assistantIds);
            const map: Record<string, FeedbackRating> = {};
            for (const fb of feedbacks) {
                map[fb.message_id] = fb.rating;
            }
            setFeedbackMap(map);
        } catch {
            // Feedback table might be empty; that's fine
            setFeedbackMap({});
        }
    }, []);

    useEffect(() => {
        let isCancelled = false;
        if (!activeChatId) {
            return () => {
                isCancelled = true;
            };
        }

        messageService.getMessages(activeChatId).then((msgs) => {
            if (isCancelled || useChatStore.getState().activeChatId !== activeChatId) return;
            setMessages(msgs);
            loadFeedbackBatch(msgs).catch(console.error);
        }).catch(console.error);

        return () => {
            isCancelled = true;
        };
    }, [activeChatId, loadFeedbackBatch]);

    const augmentPromptWithKnowledge = useCallback(async (
        prompt: string,
        knowledgeDocumentIds: string[] | null,
    ): Promise<string> => {
        const normalizedPrompt = prompt.trim();
        if (!normalizedPrompt) {
            return prompt;
        }

        // Default behavior: only use knowledge when the user explicitly selected docs.
        if (!knowledgeDocumentIds || knowledgeDocumentIds.length === 0) {
            return prompt;
        }

        let matches: KnowledgeSearchResult[] = [];
        try {
            const perDoc = await Promise.all(
                knowledgeDocumentIds.map((docId) => knowledgeService.searchVector(normalizedPrompt, {
                    documentId: docId,
                    topThreeOnly: false,
                    limit: 4,
                })),
            );
            matches = perDoc.flat();
        } catch (err) {
            console.warn('Knowledge retrieval failed, continuing without context:', err);
            return prompt;
        }

        if (matches.length === 0) {
            return prompt;
        }

        const topMatches = matches
            .sort((a, b) => b.score - a.score)
            .filter((hit, index, arr) => arr.findIndex((other) => other.chunk_id === hit.chunk_id) === index)
            .slice(0, 8);

        const context = topMatches
            .map((hit, index) => `[${index + 1}] ${hit.file_name} (score ${hit.score.toFixed(3)})\n${hit.content}`)
            .join('\n\n');

        return [
            'Use the following knowledge context when it is relevant to the user question.',
            'If context is insufficient or unrelated, say that clearly and continue with best-effort reasoning.',
            '',
            'Knowledge Context:',
            context,
            '',
            `User Question: ${prompt}`,
        ].join('\n');
    }, []);

    const handleAskLegacy = useCallback(async (prompt: string, knowledgeDocumentIds: string[] | null) => {
        const chatId = useChatStore.getState().activeChatId;
        if (!chatId) return;
        setAskError(null);
        const generationStartedAt = Date.now();

        // Create user message
        const userMessage: Message = {
            id: uuidv4(),
            chat_id: chatId,
            role: 'user',
            content: prompt,
            created_at: new Date().toISOString(),
        };

        setMessages((prev) => [...prev, userMessage]);

        try {
            await messageService.saveMessage(userMessage);
            const augmentedPrompt = await augmentPromptWithKnowledge(prompt, knowledgeDocumentIds);

            // Call generate streaming
            await generate(augmentedPrompt, async (fullText, meta) => {
                const assistantMessage: Message = {
                    id: uuidv4(),
                    chat_id: chatId,
                    role: 'assistant',
                    content: fullText,
                    created_at: new Date().toISOString(),
                };

                // Only append in the current view if the originating chat is still active.
                if (useChatStore.getState().activeChatId === chatId) {
                    setMessages((prev) => [...prev, assistantMessage]);
                }
                const elapsedSeconds = Math.max((Date.now() - generationStartedAt) / 1000, 0.05);
                const approxTokens = Math.max(1, Math.round(fullText.length / 4));
                upsertAssistantTps(assistantMessage.id, approxTokens / elapsedSeconds);
                upsertAssistantReasoning(assistantMessage.id, meta.reasoningText);
                await messageService.saveMessage(assistantMessage);
            });
        } catch {
            setMessages((prev) => prev.filter((m) => m.id !== userMessage.id));
            setAskError(GENERIC_SEND_ERROR);
        }
    }, [GENERIC_SEND_ERROR, augmentPromptWithKnowledge, generate, upsertAssistantReasoning, upsertAssistantTps]);

    const handleAskRust = useCallback(async (prompt: string, knowledgeDocumentIds: string[] | null) => {
        const chatId = useChatStore.getState().activeChatId;
        if (!chatId) return;
        setAskError(null);
        const generationStartedAt = Date.now();

        const optimisticUserMessage: Message = {
            id: uuidv4(),
            chat_id: chatId,
            role: 'user',
            content: prompt,
            created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, optimisticUserMessage]);

        let fallbackTriggered = false;
        const fallbackToLegacy = async () => {
            if (fallbackTriggered) return;
            fallbackTriggered = true;

            if (useChatStore.getState().activeChatId === chatId) {
                setMessages((prev) => prev.filter((m) => m.id !== optimisticUserMessage.id));
            }
            clearError();
            await handleAskLegacy(prompt, knowledgeDocumentIds);
        };

        try {
            await generatePipeline(
                {
                    chatId,
                    prompt,
                    selectedDocIds: knowledgeDocumentIds,
                    requestId: uuidv4(),
                },
                {
                    onComplete: async (fullText, _event, meta) => {
                        if (useChatStore.getState().activeChatId !== chatId) {
                            return;
                        }
                        const refreshedMessages = await messageService.getMessages(chatId);
                        setMessages(refreshedMessages);
                        await loadFeedbackBatch(refreshedMessages);

                        const elapsedSeconds = Math.max((Date.now() - generationStartedAt) / 1000, 0.05);
                        const approxTokens = Math.max(1, Math.round(fullText.length / 4));
                        const measuredTps = approxTokens / elapsedSeconds;

                        const matched = [...refreshedMessages]
                            .reverse()
                            .find((m) => m.role === 'assistant' && m.content === fullText)
                            ?? [...refreshedMessages].reverse().find((m) => m.role === 'assistant');

                        if (matched) {
                            upsertAssistantTps(matched.id, measuredTps);
                            upsertAssistantReasoning(matched.id, meta.reasoningText);
                        }
                    },
                    onRuntimeError: async () => {
                        await fallbackToLegacy();
                    },
                },
            );
        } catch {
            await fallbackToLegacy();
        }
    }, [clearError, generatePipeline, handleAskLegacy, loadFeedbackBatch, upsertAssistantReasoning, upsertAssistantTps]);

    const handleAsk = useCallback(async (prompt: string, knowledgeDocumentIds: string[] | null) => {
        if (pipelineMode === 'rust_v1') {
            await handleAskRust(prompt, knowledgeDocumentIds);
            return;
        }
        await handleAskLegacy(prompt, knowledgeDocumentIds);
    }, [handleAskLegacy, handleAskRust, pipelineMode]);

    const handleEditMessage = useCallback(async (messageId: string, newContent: string) => {
        const existing = messagesRef.current.find((m) => m.id === messageId);
        if (!existing) {
            return;
        }

        setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, content: newContent } : m));
        try {
            await messageService.editMessage(messageId, newContent);
        } catch (error) {
            setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, content: existing.content } : m));
            console.error('Failed to edit message', error);
        }
    }, []);

    const handleFeedback = useCallback(async (messageId: string, rating: FeedbackRating) => {
        // Read from ref instead of closing over the `messages` state.
        // This keeps the callback identity stable across renders.
        const currentMessages = messagesRef.current;
        const msgIndex = currentMessages.findIndex(m => m.id === messageId);
        const assistantMsg = currentMessages[msgIndex];
        if (!assistantMsg || assistantMsg.role !== 'assistant') return;

        // Find the previous user message as the prompt
        let prompt = '';
        for (let i = msgIndex - 1; i >= 0; i--) {
            if (currentMessages[i].role === 'user') {
                prompt = currentMessages[i].content;
                break;
            }
        }

        try {
            await feedbackService.saveFeedback(messageId, rating, prompt, assistantMsg.content);
            setFeedbackMap(prev => ({ ...prev, [messageId]: rating }));
        } catch (err) {
            console.error('Failed to save feedback:', err);
        }
    }, []);

    const displayedError = askError ?? (error ? GENERIC_GENERATION_ERROR : null);
    const dismissError = () => {
        if (askError) {
            setAskError(null);
            return;
        }
        clearError();
    };

    if (!activeChatId) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center text-neutral-500 relative bg-[#212121]">
                <div className={`absolute top-2 z-20 ${isSidebarOpen ? 'left-2' : 'left-14'}`}>
                    <ModelSelector />
                </div>
                <div className="w-16 h-16 rounded-full bg-neutral-800 flex items-center justify-center mb-4 text-2xl font-bold text-neutral-600">
                    L
                </div>
                <p>Select a chat or start a new conversation</p>
            </div>
        );
    }

    return (
        <div className="flex-1 flex flex-col h-full bg-[#212121] relative animate-[slide-up_0.2s_ease-out]">
            {/* Top Bar with Model Selection */}
            <div className={`absolute top-0 left-0 w-full z-20 flex items-center py-2 bg-gradient-to-b from-[#212121] to-transparent pointer-events-none ${isSidebarOpen ? 'px-4' : 'pl-14 pr-4'}`}>
                <div className="pointer-events-auto">
                    <ModelSelector />
                </div>
            </div>

            <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-neutral-700 pt-14"
            >
                <div className="flex flex-col min-h-full">
                    {messages.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center mt-20 mb-20 text-center px-4">
                            <h2 className="text-2xl font-semibold text-neutral-200 mb-2">How can I help you today?</h2>
                            <p className="text-neutral-500">
                                Type a message below to start chatting with {activeChat?.title || 'this model'}.
                            </p>
                        </div>
                    ) : (
                        <div className="flex-1 pb-6">
                            {messages.map((message) => (
                                <MessageBubble
                                    key={message.id}
                                    message={message}
                                    thinkingContent={message.role === 'assistant'
                                        ? assistantReasoningById[message.id] ?? ''
                                        : ''}
                                    tokensPerSecond={message.role === 'assistant'
                                        ? assistantTokensPerSecond[message.id] ?? null
                                        : null}
                                    onSaveEdit={handleEditMessage}
                                    onFeedback={message.role === 'assistant' ? handleFeedback : undefined}
                                    currentFeedback={feedbackMap[message.id] || null}
                                />
                            ))}

                            {isGenerating && (
                                <MessageBubble
                                    message={{ id: 'streaming', role: 'assistant', content: currentStream }}
                                    isStreaming={true}
                                    tokensPerSecond={liveTokensPerSecond}
                                    progressLabel={progress?.message ?? null}
                                    progressSteps={progressSteps}
                                    progressVisible={
                                        isProgressVisible
                                        && currentStream.length === 0
                                        && !isThinking
                                        && thinkingStream.length === 0
                                    }
                                    isThinking={isThinking}
                                    thinkingContent={thinkingStream}
                                />
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Generation Error Banner */}
            {displayedError && (
                <div className="mx-auto max-w-4xl w-full px-4 pb-2 animate-[slide-up_0.2s_ease-out]">
                    <div className="flex items-center gap-2 px-4 py-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-sm text-amber-400">
                        <AlertTriangle size={16} className="shrink-0" />
                        <span className="flex-1">{displayedError}</span>
                        <button
                            onClick={dismissError}
                            className="shrink-0 p-1 hover:bg-amber-500/20 rounded transition-colors"
                            title="Dismiss"
                        >
                            <X size={14} />
                        </button>
                    </div>
                </div>
            )}

            <div className="shrink-0 bg-[#212121] pt-2 pb-6 px-4 border-t border-transparent z-10 w-full max-w-4xl mx-auto">
                <ChatInput onAsk={handleAsk} isGenerating={isGenerating} onCancel={cancel} />
                <div className="text-xs text-center text-neutral-500 mt-3 hidden md:block">
                    LLMs can make mistakes. Consider verifying important information.
                </div>
            </div>
        </div>
    );
}
