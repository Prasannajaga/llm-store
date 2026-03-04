import { useEffect, useState } from 'react';
import { useChatStore } from '../../store/chatStore';
import { useStreaming } from '../../hooks/useStreaming';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { messageService } from '../../services/messageService';
import { MessageBubble } from '../message/MessageBubble';
import { ChatInput } from '../input/ChatInput';
import { ModelSelector } from '../sidebar/ModelSelector';
import type { Message } from '../../types';
import { v4 as uuidv4 } from 'uuid';

export function ChatArea() {
    const { activeChatId, chats } = useChatStore();
    const [messages, setMessages] = useState<Message[]>([]);
    const { isGenerating, currentStream, generate } = useStreaming();
    const activeChat = chats.find(c => c.id === activeChatId);

    // Auto-scroll hook depends on messages array length AND the streaming content
    const scrollRef = useAutoScroll([messages.length, currentStream]);

    useEffect(() => {
        if (activeChatId) {
            messageService.getMessages(activeChatId).then(setMessages).catch(console.error);
        } else {
            setMessages([]);
        }
    }, [activeChatId]);

    const handleAsk = async (prompt: string) => {
        if (!activeChatId) return;

        // Create user message
        const userMessage: Message = {
            id: uuidv4(),
            chat_id: activeChatId,
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
                chat_id: activeChatId,
                role: 'assistant',
                content: fullText,
                created_at: new Date().toISOString(),
            };
            setMessages((prev) => [...prev, assistantMessage]);
            await messageService.saveMessage(assistantMessage);
        });
    };

    const handleEditMessage = async (messageId: string, newContent: string) => {
        try {
            await messageService.editMessage(messageId, newContent);
            setMessages(prev => prev.map(m => m.id === messageId ? { ...m, content: newContent } : m));
            // In a real app, editing a message would probably resubmit to the LLM and truncate following context
            // But for now, we just update the message locally.
            // If you want it to trigger generation again, you'd call handleAsk(newContent) here.
        } catch (error) {
            console.error('Failed to edit message', error);
        }
    };

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

            <div className="shrink-0 bg-[#212121] pt-2 pb-6 px-4 border-t border-transparent z-10 w-full max-w-4xl mx-auto">
                <ChatInput onAsk={handleAsk} />
                <div className="text-xs text-center text-neutral-500 mt-3 hidden md:block">
                    LLMs can make mistakes. Consider verifying important information.
                </div>
            </div>
        </div>
    );
}
