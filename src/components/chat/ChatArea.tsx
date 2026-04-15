import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useChatStore } from '../../store/chatStore';
import { useStreaming } from '../../hooks/useStreaming';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { messageService } from '../../services/messageService';
import { feedbackService } from '../../services/feedbackService';
import { useSettingsStore } from '../../store/settingsStore';
import { useUiStore } from '../../store/uiStore';
import { MessageBubble } from '../message/MessageBubble';
import { ChatInput } from '../input/ChatInput';
import { ModelSelector } from '../sidebar/ModelSelector';
import { AgentProgressRail } from './AgentProgressRail';
import type {
    Message,
    FeedbackRating,
    InteractionMode,
} from '../../types';
import { v4 as uuidv4 } from 'uuid';
import { AlertTriangle, X } from 'lucide-react';
import { IconButton } from '../ui/IconButton';

const STARTER_PROMPTS = [
    'Summarize this project architecture in plain English',
    'Generate a step-by-step plan to add unit tests for streaming',
    'Review the latest response and suggest 3 improvements',
    'Help me debug a failing Rust pipeline layer',
];
const DEFAULT_NEW_CHAT_TITLE = 'New Conversation';
const AUTO_TITLE_MAX_CHARS = 60;
const AUTO_RENAME_ELIGIBLE_TITLES = new Set([
    '',
    'New Chat',
    DEFAULT_NEW_CHAT_TITLE,
]);
const DEFAULT_CONTEXT_CHAR_BUDGET = 12_000;
const HISTORY_RECENT_FRACTION = 0.72;
const HISTORY_SUMMARY_MAX_ITEMS = 12;
const HISTORY_SUMMARY_ITEM_MAX_CHARS = 150;

function normalizeInlineText(value: string): string {
    return value.split(/\s+/).filter(Boolean).join(' ').trim();
}

function clipChars(value: string, maxChars: number): string {
    if (maxChars <= 0) {
        return '';
    }
    const normalized = value.trim();
    if (normalized.length <= maxChars) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function estimateTokenCount(text: string): number {
    const trimmed = text.trim();
    if (!trimmed) {
        return 0;
    }
    return Math.max(1, Math.round(trimmed.length / 4));
}

function buildAutoCompactedConversationContext(
    historyMessages: Message[],
    maxHistoryChars: number,
): string {
    if (maxHistoryChars <= 0) {
        return '';
    }

    const turns = historyMessages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => {
            const roleLabel = message.role === 'user' ? 'User' : 'Assistant';
            const content = normalizeInlineText(message.content);
            if (!content) {
                return '';
            }
            return `${roleLabel}: ${content}`;
        })
        .filter((turn): turn is string => Boolean(turn));
    if (turns.length === 0) {
        return '';
    }

    const recentBudget = Math.max(320, Math.round(maxHistoryChars * HISTORY_RECENT_FRACTION));
    const recent: string[] = [];
    let recentChars = 0;
    for (let idx = turns.length - 1; idx >= 0; idx -= 1) {
        const turn = turns[idx];
        const turnChars = turn.length;
        const withSeparator = recent.length === 0 ? turnChars : turnChars + 1;
        if (recent.length > 0 && recentChars + withSeparator > recentBudget) {
            break;
        }
        recent.unshift(turn);
        recentChars += withSeparator;
        if (recent.length >= 18) {
            break;
        }
    }

    const summarizedTurns = turns.length - recent.length;
    const summaryBudget = Math.max(0, maxHistoryChars - recentChars - 48);
    const summary: string[] = [];
    let summaryChars = 0;
    if (summarizedTurns > 0 && summaryBudget > 96) {
        const older = turns.slice(0, summarizedTurns);
        const sliceStart = Math.max(0, older.length - HISTORY_SUMMARY_MAX_ITEMS);
        for (const turn of older.slice(sliceStart)) {
            const line = `- ${clipChars(turn, HISTORY_SUMMARY_ITEM_MAX_CHARS)}`;
            const withSeparator = summary.length === 0 ? line.length : line.length + 1;
            if (summary.length > 0 && summaryChars + withSeparator > summaryBudget) {
                break;
            }
            summary.push(line);
            summaryChars += withSeparator;
        }
        const omitted = summarizedTurns - summary.length;
        if (omitted > 0) {
            const marker = `- ... ${omitted} older turn(s) compacted`;
            if (summary.length === 0 || summaryChars + marker.length + 1 <= summaryBudget) {
                summary.push(marker);
            }
        }
    }

    const sections: string[] = [];
    if (summary.length > 0) {
        sections.push('Earlier conversation summary:');
        sections.push(summary.join('\n'));
    }
    if (recent.length > 0) {
        sections.push('Recent conversation turns:');
        sections.push(recent.join('\n'));
    }

    const context = sections.join('\n\n');
    if (context.length <= maxHistoryChars) {
        return context;
    }
    return context.slice(0, maxHistoryChars);
}

interface AskOptions {
    source?: 'input' | 'starter';
}

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
        pendingAgentConfirmation,
        approveAgentToolOnce,
        approveAgentToolAlways,
        denyAgentTool,
        generatePipeline,
        cancel,
        clearError,
    } = useStreaming();
    const [askError, setAskError] = useState<string | null>(null);
    const agentModeEnabled = useSettingsStore((s) => s.generation.agentMode);
    const effectiveInteractionMode: InteractionMode = agentModeEnabled
        ? 'agent'
        : 'chat';
    const maxContextCharsSetting = useSettingsStore((s) => s.generation.maxContextChars);
    const llamaContextSizeSetting = useSettingsStore((s) => s.llamaServer.contextSize);
    const isSidebarOpen = useUiStore((s) => s.isSidebarOpen);
    const activeChat = useMemo(() => chats.find(c => c.id === activeChatId), [chats, activeChatId]);
    const [feedbackMap, setFeedbackMap] = useState<Record<string, FeedbackRating>>({});
    const [assistantTokensPerSecond, setAssistantTokensPerSecond] = useState<Record<string, number>>({});
    const [assistantReasoningById, setAssistantReasoningById] = useState<Record<string, string>>({});
    const GENERIC_GENERATION_ERROR = 'Something went wrong while generating. Please try again.';
    const GENERIC_REGENERATE_ERROR = 'Unable to regenerate response right now. Please try again.';
    const PERSIST_RETRY_ATTEMPTS = 6;
    const PERSIST_RETRY_DELAY_MS = 140;

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

    const clearAssistantTelemetry = useCallback((messageId: string) => {
        setAssistantTokensPerSecond((prev) => {
            if (!(messageId in prev)) {
                return prev;
            }
            const next = { ...prev };
            delete next[messageId];
            return next;
        });
        setAssistantReasoningById((prev) => {
            if (!(messageId in prev)) {
                return prev;
            }
            const next = { ...prev };
            delete next[messageId];
            return next;
        });
    }, []);

    const latestAssistantMessageId = useMemo(() => {
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') {
                return messages[i].id;
            }
        }
        return null;
    }, [messages]);

    const inputContextWindow = useMemo(() => {
        const maxContextChars = Math.max(1_500, maxContextCharsSetting || DEFAULT_CONTEXT_CHAR_BUDGET);
        const historyBudget = Math.max(1_000, Math.round(maxContextChars * 0.5));
        const contextText = buildAutoCompactedConversationContext(messages, historyBudget);
        const usedTokens = estimateTokenCount(contextText);
        const maxTokens = Math.max(
            256,
            llamaContextSizeSetting || Math.round(maxContextChars / 4),
        );

        return {
            usedTokens,
            maxTokens,
            contextText,
        };
    }, [llamaContextSizeSetting, maxContextCharsSetting, messages]);

    const hydrateAssistantReasoning = useCallback((msgs: Message[]) => {
        setAssistantReasoningById((prev) => {
            const next: Record<string, string> = { ...prev };
            for (const message of msgs) {
                if (message.role !== 'assistant') {
                    continue;
                }
                const persistedReasoning = message.reasoning_content?.trim();
                if (persistedReasoning) {
                    next[message.id] = persistedReasoning;
                }
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
            hydrateAssistantReasoning(msgs);
            loadFeedbackBatch(msgs).catch(console.error);
        }).catch(console.error);

        return () => {
            isCancelled = true;
        };
    }, [activeChatId, hydrateAssistantReasoning, loadFeedbackBatch]);

    const maybeAutoRenameStarterChat = useCallback(async (
        chatId: string,
        prompt: string,
        options: AskOptions | undefined,
        historyBeforeSend: Message[],
    ) => {
        if (options?.source !== 'starter' || historyBeforeSend.length > 0) {
            return;
        }

        const store = useChatStore.getState();
        const currentChat = store.chats.find((chat) => chat.id === chatId);
        if (!currentChat) {
            return;
        }

        const currentTitle = currentChat.title.trim();
        if (!AUTO_RENAME_ELIGIBLE_TITLES.has(currentTitle)) {
            return;
        }

        const nextTitle = clipChars(normalizeInlineText(prompt), AUTO_TITLE_MAX_CHARS);
        if (!nextTitle || nextTitle === currentTitle) {
            return;
        }

        try {
            await store.renameChat(chatId, nextTitle);
        } catch (error) {
            console.warn('Starter prompt chat auto-rename failed:', error);
        }
    }, []);

    const handleAskRust = useCallback(async (
        prompt: string,
        knowledgeDocumentIds: string[] | null,
        options?: AskOptions,
    ) => {
        const chatId = useChatStore.getState().activeChatId;
        if (!chatId) return;
        setAskError(null);
        const generationStartedAt = Date.now();
        const historyBeforeSend = messagesRef.current;

        const optimisticUserMessage: Message = {
            id: uuidv4(),
            chat_id: chatId,
            role: 'user',
            content: prompt,
            created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, optimisticUserMessage]);

        const handlePipelineFailure = async () => {
            if (useChatStore.getState().activeChatId === chatId) {
                setMessages((prev) => prev.filter((m) => m.id !== optimisticUserMessage.id));
            }
            setAskError('Rust pipeline failed. Check terminal logs for layer-level details.');
        };

        try {
            await generatePipeline(
                {
                    chatId,
                    prompt,
                    selectedDocIds: knowledgeDocumentIds,
                    requestId: uuidv4(),
                    interactionMode: effectiveInteractionMode,
                },
                {
                    onComplete: async (fullText, event, meta) => {
                        if (useChatStore.getState().activeChatId !== chatId) {
                            return;
                        }
                        const normalizedReasoning = meta.reasoningText.trim();
                        const optimisticAssistant: Message = {
                            id: uuidv4(),
                            chat_id: chatId,
                            role: 'assistant',
                            content: fullText,
                            reasoning_content: normalizedReasoning || null,
                            context_payload: event.contextPayload ?? null,
                            created_at: new Date().toISOString(),
                        };

                        setMessages((prev) => {
                            const alreadyExists = [...prev]
                                .reverse()
                                .some((m) => m.role === 'assistant' && m.content === fullText);
                            if (alreadyExists) {
                                return prev;
                            }
                            return [...prev, optimisticAssistant];
                        });
                        const elapsedSeconds = Math.max((Date.now() - generationStartedAt) / 1000, 0.05);
                        const approxTokens = Math.max(1, Math.round(fullText.length / 4));
                        const measuredTps = approxTokens / elapsedSeconds;
                        upsertAssistantTps(optimisticAssistant.id, measuredTps);
                        upsertAssistantReasoning(optimisticAssistant.id, normalizedReasoning);
                        await maybeAutoRenameStarterChat(chatId, prompt, options, historyBeforeSend);

                        for (let attempt = 0; attempt < PERSIST_RETRY_ATTEMPTS; attempt++) {
                            const refreshedMessages = await messageService.getMessages(chatId);
                            if (useChatStore.getState().activeChatId !== chatId) {
                                return;
                            }
                            const matched = [...refreshedMessages]
                                .reverse()
                                .find((m) => m.role === 'assistant' && m.content === fullText);

                            if (matched) {
                                setMessages(refreshedMessages);
                                hydrateAssistantReasoning(refreshedMessages);
                                await loadFeedbackBatch(refreshedMessages);
                                upsertAssistantTps(matched.id, measuredTps);
                                upsertAssistantReasoning(
                                    matched.id,
                                    matched.reasoning_content ?? normalizedReasoning,
                                );
                                return;
                            }

                            if (attempt < PERSIST_RETRY_ATTEMPTS - 1) {
                                await new Promise((resolve) => {
                                    setTimeout(resolve, PERSIST_RETRY_DELAY_MS);
                                });
                            }
                        }
                    },
                    onRuntimeError: handlePipelineFailure,
                },
            );
        } catch {
            await handlePipelineFailure();
        }
    }, [
        PERSIST_RETRY_ATTEMPTS,
        PERSIST_RETRY_DELAY_MS,
        effectiveInteractionMode,
        generatePipeline,
        hydrateAssistantReasoning,
        loadFeedbackBatch,
        maybeAutoRenameStarterChat,
        upsertAssistantReasoning,
        upsertAssistantTps,
    ]);

    const handleAsk = useCallback(async (
        prompt: string,
        knowledgeDocumentIds: string[] | null,
        options?: AskOptions,
    ) => {
        await handleAskRust(prompt, knowledgeDocumentIds, options);
    }, [handleAskRust]);

    const handleRegenerateAssistant = useCallback(async (assistantMessageId: string) => {
        if (isGenerating) {
            return;
        }

        const chatId = useChatStore.getState().activeChatId;
        if (!chatId) {
            return;
        }

        const currentMessages = messagesRef.current;
        const assistantIndex = currentMessages.findIndex(
            (m) => m.id === assistantMessageId && m.role === 'assistant',
        );
        if (assistantIndex === -1) {
            return;
        }

        let prompt = '';
        for (let i = assistantIndex - 1; i >= 0; i--) {
            if (currentMessages[i].role === 'user') {
                prompt = currentMessages[i].content.trim();
                break;
            }
        }
        if (!prompt) {
            return;
        }

        const replaceAssistantInState = (replacement: Message) => {
            setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === assistantMessageId);
                if (idx === -1) {
                    return prev;
                }
                const next = [...prev];
                next[idx] = replacement;
                return next;
            });
        };

        const clearAssistantFeedback = () => {
            setFeedbackMap((prev) => {
                if (!(assistantMessageId in prev)) {
                    return prev;
                }
                const next = { ...prev };
                delete next[assistantMessageId];
                return next;
            });
        };

        setAskError(null);
        const generationStartedAt = Date.now();

        try {
            await generatePipeline(
                {
                    chatId,
                    prompt,
                    selectedDocIds: null,
                    requestId: uuidv4(),
                    interactionMode: effectiveInteractionMode,
                },
                {
                    onComplete: async (fullText, event, meta) => {
                        if (useChatStore.getState().activeChatId !== chatId) {
                            return;
                        }

                        const normalizedReasoning = meta.reasoningText.trim();
                        const optimisticAssistant: Message = {
                            id: uuidv4(),
                            chat_id: chatId,
                            role: 'assistant',
                            content: fullText,
                            reasoning_content: normalizedReasoning || null,
                            context_payload: event.contextPayload ?? null,
                            created_at: new Date().toISOString(),
                        };

                        replaceAssistantInState(optimisticAssistant);
                        clearAssistantTelemetry(assistantMessageId);
                        clearAssistantFeedback();

                        const elapsedSeconds = Math.max((Date.now() - generationStartedAt) / 1000, 0.05);
                        const approxTokens = Math.max(1, Math.round(fullText.length / 4));
                        const measuredTps = approxTokens / elapsedSeconds;
                        upsertAssistantTps(optimisticAssistant.id, measuredTps);
                        upsertAssistantReasoning(optimisticAssistant.id, normalizedReasoning);

                        await messageService.deleteMessage(assistantMessageId).catch((err) => {
                            console.warn('Failed to delete old regenerated assistant message:', err);
                        });

                        for (let attempt = 0; attempt < PERSIST_RETRY_ATTEMPTS; attempt++) {
                            const refreshedMessages = await messageService.getMessages(chatId);
                            if (useChatStore.getState().activeChatId !== chatId) {
                                return;
                            }
                            const matched = [...refreshedMessages]
                                .reverse()
                                .find((m) => m.role === 'assistant' && m.content === fullText);

                            if (matched) {
                                setMessages(refreshedMessages);
                                hydrateAssistantReasoning(refreshedMessages);
                                await loadFeedbackBatch(refreshedMessages);
                                upsertAssistantTps(matched.id, measuredTps);
                                upsertAssistantReasoning(
                                    matched.id,
                                    matched.reasoning_content ?? normalizedReasoning,
                                );
                                return;
                            }

                            if (attempt < PERSIST_RETRY_ATTEMPTS - 1) {
                                await new Promise((resolve) => {
                                    setTimeout(resolve, PERSIST_RETRY_DELAY_MS);
                                });
                            }
                        }
                    },
                    onRuntimeError: async () => {
                        setAskError(GENERIC_REGENERATE_ERROR);
                    },
                },
            );
        } catch {
            setAskError(GENERIC_REGENERATE_ERROR);
        }
    }, [GENERIC_REGENERATE_ERROR, PERSIST_RETRY_ATTEMPTS, PERSIST_RETRY_DELAY_MS, clearAssistantTelemetry, effectiveInteractionMode, generatePipeline, hydrateAssistantReasoning, isGenerating, loadFeedbackBatch, upsertAssistantReasoning, upsertAssistantTps]);

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

    const handleStarterPrompt = useCallback((prompt: string) => {
        if (isGenerating) {
            return;
        }
        void handleAsk(prompt, null, { source: 'starter' });
    }, [handleAsk, isGenerating]);

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
            <div className="flex-1 flex flex-col items-center justify-center text-neutral-500 relative bg-[var(--surface-app)]">
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
        <div className="flex-1 flex flex-col h-full bg-[var(--surface-app)] relative animate-[slide-up_0.2s_ease-out]">
            {/* Top Bar with Model Selection */}
            <div className={`absolute top-0 left-0 w-full z-20 flex items-center py-2 bg-gradient-to-b from-[var(--surface-app)] to-transparent pointer-events-none ${isSidebarOpen ? 'px-4' : 'pl-14 pr-4'}`}>
                <div className="pointer-events-auto flex items-center gap-2.5">
                    <ModelSelector />
                    <span className="hidden md:inline-flex items-center px-2.5 py-1 rounded-full border border-neutral-700 text-[11px] text-neutral-400 max-w-[300px] truncate">
                        {activeChat?.title || 'Conversation'}
                    </span>
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
                            <div className="mt-6 grid w-full max-w-3xl grid-cols-1 md:grid-cols-2 gap-2.5">
                                {STARTER_PROMPTS.map((starter) => (
                                    <button
                                        key={starter}
                                        onClick={() => handleStarterPrompt(starter)}
                                        disabled={isGenerating}
                                        className="text-left rounded-xl border border-neutral-700 bg-neutral-900/40 hover:bg-neutral-800/60 px-4 py-3 text-sm text-neutral-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {starter}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <div className="flex-1 pb-6">
                            {messages.map((message) => (
                                <MessageBubble
                                    key={message.id}
                                    message={message}
                                    thinkingContent={message.role === 'assistant'
                                        ? (assistantReasoningById[message.id]
                                            ?? message.reasoning_content?.trim()
                                            ?? '')
                                        : ''}
                                    tokensPerSecond={message.role === 'assistant'
                                        ? assistantTokensPerSecond[message.id] ?? null
                                        : null}
                                    onSaveEdit={handleEditMessage}
                                    onRegenerate={message.role === 'assistant'
                                        && message.id === latestAssistantMessageId
                                        && !isGenerating
                                        ? handleRegenerateAssistant
                                        : undefined}
                                    onFeedback={message.role === 'assistant' ? handleFeedback : undefined}
                                    currentFeedback={feedbackMap[message.id] || null}
                                />
                            ))}

                            <AgentProgressRail
                                steps={progressSteps}
                                currentStep={progress}
                                isVisible={isProgressVisible}
                            />

                            {isGenerating && (
                                <MessageBubble
                                    message={{ id: 'streaming', role: 'assistant', content: currentStream }}
                                    isStreaming={true}
                                    tokensPerSecond={liveTokensPerSecond}
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
                        <IconButton
                            onClick={dismissError}
                            icon={<X size={14} />}
                            ariaLabel="Dismiss generation error"
                            tone="warning"
                            size="xs"
                            className="shrink-0 hover:bg-amber-500/20"
                        />
                    </div>
                </div>
            )}

            {pendingAgentConfirmation && (
                <div className="mx-auto max-w-4xl w-full px-4 pb-2 animate-[slide-up_0.2s_ease-out]">
                    <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
                        <p className="font-medium">Agent action approval required</p>
                        <p className="mt-1 text-sky-100/90">{pendingAgentConfirmation.summary}</p>
                        {pendingAgentConfirmation.argsPreview ? (
                            <pre className="mt-2 max-h-28 overflow-y-auto rounded border border-sky-500/20 bg-black/25 p-2 text-[11px] leading-relaxed text-sky-100/85 whitespace-pre-wrap font-sans">
                                {pendingAgentConfirmation.argsPreview}
                            </pre>
                        ) : null}
                        <div className="mt-3 flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => void approveAgentToolOnce()}
                                className="rounded-md border border-emerald-500/40 bg-emerald-500/20 px-2.5 py-1 text-xs text-emerald-100 hover:bg-emerald-500/30 transition-colors"
                            >
                                Approve once
                            </button>
                            <button
                                type="button"
                                onClick={() => void approveAgentToolAlways()}
                                className="rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-xs text-emerald-100 hover:bg-emerald-500/25 transition-colors"
                            >
                                Always allow
                            </button>
                            <button
                                type="button"
                                onClick={() => void denyAgentTool()}
                                className="rounded-md border border-red-500/40 bg-red-500/20 px-2.5 py-1 text-xs text-red-100 hover:bg-red-500/30 transition-colors"
                            >
                                Deny
                            </button>
                            <span className="text-[11px] text-sky-100/70">
                                Tool: {pendingAgentConfirmation.tool}
                            </span>
                            {pendingAgentConfirmation.pattern ? (
                                <span className="text-[11px] text-sky-100/70">
                                    Rule: {pendingAgentConfirmation.pattern}
                                </span>
                            ) : null}
                        </div>
                    </div>
                </div>
            )}

            <div className="shrink-0 bg-[var(--surface-app)] pt-2 pb-6 px-4 border-t border-transparent z-10 w-full max-w-4xl mx-auto">
                <ChatInput
                    onAsk={handleAsk}
                    isGenerating={isGenerating}
                    onCancel={cancel}
                    contextWindow={inputContextWindow}
                />
                <div className="text-xs text-center text-neutral-500 mt-3 hidden md:block">
                    LLMs can make mistakes. Consider verifying important information.
                </div>
            </div>
        </div>
    );
}
