import { memo, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useChatStore } from '../../store/chatStore';
import { useStreaming, type LayerProgressStep } from '../../hooks/useStreaming';
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
import { Button } from '../ui/Button';

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

interface ChatMessageHistoryProps {
    messages: Message[];
    assistantReasoningById: Record<string, string>;
    assistantTokensPerSecond: Record<string, number>;
    feedbackMap: Record<string, FeedbackRating>;
    completedProgressSteps: Record<string, LayerProgressStep[]>;
    latestAssistantMessageId: string | null;
    isGenerating: boolean;
    onSaveEdit: (messageId: string, newContent: string) => void | Promise<void>;
    onRegenerate: (messageId: string) => void | Promise<void>;
    onFeedback: (messageId: string, rating: FeedbackRating) => void | Promise<void>;
}

const ChatMessageHistory = memo(function ChatMessageHistory({
    messages,
    assistantReasoningById,
    assistantTokensPerSecond,
    feedbackMap,
    completedProgressSteps,
    latestAssistantMessageId,
    isGenerating,
    onSaveEdit,
    onRegenerate,
    onFeedback,
}: ChatMessageHistoryProps) {
    return (
        <>
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
                    liveProgressSteps={message.role === 'assistant'
                        ? completedProgressSteps[message.id]
                        : undefined}
                    onSaveEdit={onSaveEdit}
                    onRegenerate={message.role === 'assistant'
                        && message.id === latestAssistantMessageId
                        && !isGenerating
                        ? onRegenerate
                        : undefined}
                    onFeedback={message.role === 'assistant' ? onFeedback : undefined}
                    currentFeedback={feedbackMap[message.id] || null}
                />
            ))}
        </>
    );
});

export function ChatArea() {
    const activeChatId = useChatStore((state) => state.activeChatId);
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
        isSubmittingAgentDecision,
        agentDecisionError,
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
    const [feedbackMap, setFeedbackMap] = useState<Record<string, FeedbackRating>>({});
    const [assistantTokensPerSecond, setAssistantTokensPerSecond] = useState<Record<string, number>>({});
    const [assistantReasoningById, setAssistantReasoningById] = useState<Record<string, string>>({});
    const [completedProgressSteps, setCompletedProgressSteps] = useState<Record<string, LayerProgressStep[]>>({});
    const [approvalDetailOpen, setApprovalDetailOpen] = useState(false);
    const GENERIC_GENERATION_ERROR = 'Something went wrong while generating. Please try again.';
    const GENERIC_REGENERATE_ERROR = 'Unable to regenerate response right now. Please try again.';
    const PERSIST_SYNC_DELAY_MS = 220;

    // Reset approval detail panel whenever a new confirmation event arrives.
    const pendingActionId = pendingAgentConfirmation?.actionId ?? null;
    useEffect(() => {
        setApprovalDetailOpen(false);
    }, [pendingActionId]);

    // Keep a ref to the latest messages so handleFeedback never closes over stale state.
    // This allows the callback identity to remain stable (no `messages` dependency).
    const messagesRef = useRef<Message[]>(messages);
    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    // Gap 1: always-current ref for progressSteps to avoid stale closures in onComplete.
    const progressStepsRef = useRef<LayerProgressStep[]>(progressSteps);
    useEffect(() => {
        progressStepsRef.current = progressSteps;
    }, [progressSteps]);

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
        () => [messages.length, currentStream.length, thinkingStream.length],
        [messages.length, currentStream.length, thinkingStream.length],
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

    const syncPersistedAssistantOnce = useCallback(async (
        chatId: string,
        assistantMessageId: string,
        measuredTps: number,
        fallbackReasoning: string,
    ) => {
        await new Promise((resolve) => {
            setTimeout(resolve, PERSIST_SYNC_DELAY_MS);
        });
        const refreshedMessages = await messageService.getMessages(chatId);
        if (useChatStore.getState().activeChatId !== chatId) {
            return;
        }
        const matched = refreshedMessages.find(
            (m) => m.id === assistantMessageId && m.role === 'assistant',
        );
        if (!matched) {
            return;
        }
        setMessages(refreshedMessages);
        hydrateAssistantReasoning(refreshedMessages);
        await loadFeedbackBatch(refreshedMessages);
        upsertAssistantTps(assistantMessageId, measuredTps);
        upsertAssistantReasoning(
            assistantMessageId,
            matched.reasoning_content ?? fallbackReasoning,
        );
    }, [
        PERSIST_SYNC_DELAY_MS,
        hydrateAssistantReasoning,
        loadFeedbackBatch,
        upsertAssistantReasoning,
        upsertAssistantTps,
    ]);

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
        const optimisticAssistantMessageId = uuidv4();
        const requestId = uuidv4();
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
                    requestId,
                    interactionMode: effectiveInteractionMode,
                    optimisticUserMessageId: optimisticUserMessage.id,
                    optimisticAssistantMessageId,
                },
                {
                    onComplete: async (fullText, event, meta) => {
                        if (useChatStore.getState().activeChatId !== chatId) {
                            return;
                        }
                        const normalizedReasoning = meta.reasoningText.trim();
                        const optimisticAssistant: Message = {
                            id: optimisticAssistantMessageId,
                            chat_id: chatId,
                            role: 'assistant',
                            content: fullText,
                            reasoning_content: normalizedReasoning || null,
                            context_payload: event.contextPayload ?? null,
                            created_at: new Date().toISOString(),
                        };

                        setMessages((prev) => {
                            const alreadyExists = prev.some((m) => m.id === optimisticAssistant.id);
                            if (alreadyExists) {
                                return prev;
                            }
                            return [...prev, optimisticAssistant];
                        });
                        // Gap 1: use ref to get final state of progress steps at completion time
                        setCompletedProgressSteps((prev) => ({
                            ...prev,
                            [optimisticAssistant.id]: [...progressStepsRef.current],
                        }));
                        const elapsedSeconds = Math.max((Date.now() - generationStartedAt) / 1000, 0.05);
                        const approxTokens = Math.max(1, Math.round(fullText.length / 4));
                        const measuredTps = approxTokens / elapsedSeconds;
                        upsertAssistantTps(optimisticAssistant.id, measuredTps);
                        upsertAssistantReasoning(optimisticAssistant.id, normalizedReasoning);
                        await maybeAutoRenameStarterChat(chatId, prompt, options, historyBeforeSend);
                        // Gap 6: clear live steps after backend has persisted context_payload
                        await syncPersistedAssistantOnce(
                            chatId,
                            optimisticAssistant.id,
                            measuredTps,
                            normalizedReasoning,
                        ).then(() => {
                            setCompletedProgressSteps((prev) => {
                                if (!(optimisticAssistant.id in prev)) return prev;
                                const next = { ...prev };
                                delete next[optimisticAssistant.id];
                                return next;
                            });
                        }).catch((err) => {
                            console.warn('Assistant persistence sync skipped:', err);
                        });
                    },
                    onRuntimeError: handlePipelineFailure,
                },
            );
        } catch {
            await handlePipelineFailure();
        }
    }, [
        effectiveInteractionMode,
        generatePipeline,
        maybeAutoRenameStarterChat,
        syncPersistedAssistantOnce,
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
        const regeneratedAssistantMessageId = uuidv4();
        const requestId = uuidv4();

        try {
            await generatePipeline(
                {
                    chatId,
                    prompt,
                    selectedDocIds: null,
                    requestId,
                    interactionMode: effectiveInteractionMode,
                    optimisticAssistantMessageId: regeneratedAssistantMessageId,
                },
                {
                    onComplete: async (fullText, event, meta) => {
                        if (useChatStore.getState().activeChatId !== chatId) {
                            return;
                        }

                        const normalizedReasoning = meta.reasoningText.trim();
                        const optimisticAssistant: Message = {
                            id: regeneratedAssistantMessageId,
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

                        // Gap 1: use ref to avoid stale closure; Gap 6: old entry removed immediately
                        setCompletedProgressSteps((prev) => {
                            const next = { ...prev, [optimisticAssistant.id]: [...progressStepsRef.current] };
                            delete next[assistantMessageId];
                            return next;
                        });

                        const elapsedSeconds = Math.max((Date.now() - generationStartedAt) / 1000, 0.05);
                        const approxTokens = Math.max(1, Math.round(fullText.length / 4));
                        const measuredTps = approxTokens / elapsedSeconds;
                        upsertAssistantTps(optimisticAssistant.id, measuredTps);
                        upsertAssistantReasoning(optimisticAssistant.id, normalizedReasoning);

                        await messageService.deleteMessage(assistantMessageId).catch((err) => {
                            console.warn('Failed to delete old regenerated assistant message:', err);
                        });
                        // Gap 6: clear live steps after backend has persisted context_payload
                        await syncPersistedAssistantOnce(
                            chatId,
                            optimisticAssistant.id,
                            measuredTps,
                            normalizedReasoning,
                        ).then(() => {
                            setCompletedProgressSteps((prev) => {
                                if (!(optimisticAssistant.id in prev)) return prev;
                                const next = { ...prev };
                                delete next[optimisticAssistant.id];
                                return next;
                            });
                        }).catch((err) => {
                            console.warn('Regenerate persistence sync skipped:', err);
                        });
                    },
                    onRuntimeError: async () => {
                        setAskError(GENERIC_REGENERATE_ERROR);
                    },
                },
            );
        } catch {
            setAskError(GENERIC_REGENERATE_ERROR);
        }
    }, [GENERIC_REGENERATE_ERROR, clearAssistantTelemetry, effectiveInteractionMode, generatePipeline, isGenerating, syncPersistedAssistantOnce, upsertAssistantReasoning, upsertAssistantTps]);

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
                <div className={`absolute top-3 z-20 ${isSidebarOpen ? 'left-3' : 'left-14'}`}>
                    <ModelSelector />
                </div>
                <p className="text-sm">Select a chat or start a new conversation</p>
            </div>
        );
    }

    return (
        <div className="flex-1 flex flex-col h-full bg-[var(--surface-app)] relative">
            {/* Top Bar */}
            <div className={`sticky top-0 z-20 flex items-center h-12 bg-[var(--surface-app)] border-b border-neutral-800 ${isSidebarOpen ? 'px-4' : 'pl-14 pr-4'}`}>
                <ModelSelector />
            </div>

            <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-neutral-700 pt-3"
            >
                <div className="flex flex-col min-h-full">
                    {messages.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center mt-16 mb-16 text-center px-4">
                            <h2 className="text-xl font-medium text-neutral-200 mb-1">How can I help you today?</h2>
                            <p className="text-sm text-neutral-500 mb-6">Ask anything to get started.</p>
                            <div className="grid w-full max-w-2xl grid-cols-1 md:grid-cols-2 gap-2">
                                {STARTER_PROMPTS.map((starter) => (
                                    <button
                                        key={starter}
                                        onClick={() => handleStarterPrompt(starter)}
                                        disabled={isGenerating}
                                        className="text-left rounded-xl border border-neutral-800 hover:border-neutral-700 hover:bg-neutral-800/40 px-4 py-3 text-sm text-neutral-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
                                    >
                                        {starter}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <div className="flex-1 pb-6">
                            <ChatMessageHistory
                                messages={messages}
                                assistantReasoningById={assistantReasoningById}
                                assistantTokensPerSecond={assistantTokensPerSecond}
                                feedbackMap={feedbackMap}
                                completedProgressSteps={completedProgressSteps}
                                latestAssistantMessageId={latestAssistantMessageId}
                                isGenerating={isGenerating}
                                onSaveEdit={handleEditMessage}
                                onRegenerate={handleRegenerateAssistant}
                                onFeedback={handleFeedback}
                            />

                            <AgentProgressRail
                                steps={progressSteps}
                                currentStep={progress}
                                isVisible={isProgressVisible}
                                isComplete={!isGenerating && !isProgressVisible}
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
                <div className="mx-auto max-w-3xl w-full px-4 pb-2">
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
                <div className="agent-approval-banner">
                    <div className="agent-approval-inner">
                        <div className="agent-approval-info">
                            {/* Gap 9: color tool badge by risk level */}
                            <span className={`agent-approval-tool ${
                                pendingAgentConfirmation.riskLevel === 'high'
                                    ? 'agent-approval-tool--high'
                                    : pendingAgentConfirmation.riskLevel === 'confirm'
                                        ? 'agent-approval-tool--confirm'
                                        : ''
                            }`}>{pendingAgentConfirmation.tool}</span>
                            <span className="agent-approval-arrow">→</span>
                            <span className="agent-approval-summary">{pendingAgentConfirmation.summary}</span>
                            {pendingAgentConfirmation.argsPreview ? (
                                <button
                                    type="button"
                                    onClick={() => setApprovalDetailOpen((prev) => !prev)}
                                    className="text-neutral-500 hover:text-neutral-300 transition-colors ml-1 shrink-0"
                                    aria-label="Toggle details"
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="12" cy="12" r="10" />
                                        <line x1="12" y1="16" x2="12" y2="12" />
                                        <line x1="12" y1="8" x2="12.01" y2="8" />
                                    </svg>
                                </button>
                            ) : null}
                        </div>
                        <div className="agent-approval-actions">
                            <Button
                                variant="secondary"
                                size="sm"
                                disabled={isSubmittingAgentDecision}
                                onClick={() => void approveAgentToolOnce()}
                            >
                                {isSubmittingAgentDecision ? '...' : 'Allow'}
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={isSubmittingAgentDecision}
                                onClick={() => void approveAgentToolAlways()}
                            >
                                Always
                            </Button>
                            <Button
                                variant="danger"
                                size="sm"
                                disabled={isSubmittingAgentDecision}
                                onClick={() => void denyAgentTool()}
                            >
                                Deny
                            </Button>
                        </div>
                    </div>
                    <div className={`agent-approval-detail ${approvalDetailOpen ? 'agent-approval-detail--open' : ''}`}>
                        {approvalDetailOpen && pendingAgentConfirmation.argsPreview ? (
                            <pre className="agent-approval-detail-pre">
                                {pendingAgentConfirmation.argsPreview}
                            </pre>
                        ) : null}
                        {approvalDetailOpen && pendingAgentConfirmation.outsideTrustedRoots
                            && pendingAgentConfirmation.rootCandidate ? (
                                <p className="agent-approval-trust-note">
                                    Outside trusted folders. <strong>Always</strong> will trust: {pendingAgentConfirmation.rootCandidate}
                                </p>
                            ) : null}
                    </div>
                    {agentDecisionError ? (
                        <p className="agent-approval-error">{agentDecisionError}</p>
                    ) : null}
                </div>
            )}

            <div className="shrink-0 bg-[var(--surface-app)] pt-2 pb-4 px-4 z-10 w-full max-w-3xl mx-auto">
                <ChatInput
                    onAsk={handleAsk}
                    isGenerating={isGenerating}
                    onCancel={cancel}
                    contextWindow={inputContextWindow}
                />
                <div className="text-[11px] text-center text-neutral-600 mt-2 hidden md:block">
                    LLMs can make mistakes. Consider verifying important information.
                </div>
            </div>
        </div>
    );
}
