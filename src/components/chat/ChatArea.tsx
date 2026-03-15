import { useEffect, useState, useCallback, useMemo } from 'react';
import { useChatStore } from '../../store/chatStore';
import { useStreaming } from '../../hooks/useStreaming';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { messageService } from '../../services/messageService';
import { feedbackService } from '../../services/feedbackService';
import { MessageBubble } from '../message/MessageBubble';
import { ChatInput } from '../input/ChatInput';
import { ModelSelector } from '../sidebar/ModelSelector';
import type { Message, FeedbackRating } from '../../types';
import { v4 as uuidv4 } from 'uuid';
import { AlertTriangle, X } from 'lucide-react';

export function ChatArea() {
    const { activeChatId, chats } = useChatStore();
    const [messages, setMessages] = useState<Message[]>([]);
    const { isGenerating, currentStream, error, generate, cancel, clearError } = useStreaming();
    const activeChat = useMemo(() => chats.find(c => c.id === activeChatId), [chats, activeChatId]);
    const [feedbackMap, setFeedbackMap] = useState<Record<string, FeedbackRating>>({});

    // Auto-scroll hook depends on messages array length AND the streaming content
    const scrollRef = useAutoScroll([messages.length, currentStream]);

    useEffect(() => {
        if (activeChatId) {
            messageService.getMessages(activeChatId).then((msgs) => {
                setMessages(msgs);
                // Batch-load all feedback in a single call (replaces N+1 loop)
                loadFeedbackBatch(msgs);
            }).catch(console.error);
        } else {
            setMessages([]);
            setFeedbackMap({});
        }
    }, [activeChatId]);

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

    const handleAsk = useCallback(async (prompt: string) => {
        const chatId = useChatStore.getState().activeChatId;
        if (!chatId) return;

        // Create user message
        const userMessage: Message = {
            id: uuidv4(),
            chat_id: chatId,
            role: 'user',
            content: prompt,
            created_at: new Date().toISOString(),
        };

        setMessages((prev) => [...prev, userMessage]);
        await messageService.saveMessage(userMessage);

        // Call generate streaming
        await generate(prompt, async (fullText) => {
            const assistantMessage: Message = {
                id: uuidv4(),
                chat_id: chatId,
                role: 'assistant',
                content: fullText,
                created_at: new Date().toISOString(),
            };
            setMessages((prev) => [...prev, assistantMessage]);
            await messageService.saveMessage(assistantMessage);
        });
    }, [generate]);

    const handleEditMessage = useCallback(async (messageId: string, newContent: string) => {
        try {
            await messageService.editMessage(messageId, newContent);
            setMessages(prev => prev.map(m => m.id === messageId ? { ...m, content: newContent } : m));
        } catch (error) {
            console.error('Failed to edit message', error);
        }
    }, []);

    const handleFeedback = useCallback(async (messageId: string, rating: FeedbackRating) => {
        // Find the assistant message and its preceding user message (the prompt)
        const currentMessages = messages;
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
    }, [messages]);

    if (!activeChatId) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center text-neutral-500 relative bg-[#212121]">
                <div className="absolute top-2 left-2 z-20">
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
            <div className="absolute top-0 left-0 w-full z-20 flex items-center px-2 py-2 bg-gradient-to-b from-[#212121] to-transparent pointer-events-none">
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
                        <div className="flex-1 pb-4">
                            {messages.map((message) => (
                                <MessageBubble
                                    key={message.id}
                                    message={message}
                                    onSaveEdit={handleEditMessage}
                                    onFeedback={message.role === 'assistant' ? handleFeedback : undefined}
                                    currentFeedback={feedbackMap[message.id] || null}
                                />
                            ))}

                            {isGenerating && (
                                <MessageBubble
                                    message={{ id: 'streaming', role: 'assistant', content: currentStream }}
                                    isStreaming={true}
                                />
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Generation Error Banner */}
            {error && (
                <div className="mx-auto max-w-3xl w-full px-4 pb-2 animate-[slide-up_0.2s_ease-out]">
                    <div className="flex items-center gap-2 px-4 py-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-sm text-amber-400">
                        <AlertTriangle size={16} className="shrink-0" />
                        <span className="flex-1">{error}</span>
                        <button
                            onClick={clearError}
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
