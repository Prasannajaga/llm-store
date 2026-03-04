import ReactTextareaAutosize from 'react-textarea-autosize';
import { ArrowUp, Square } from 'lucide-react';
import { KeyboardEvent, useState, useRef, useEffect } from 'react';
import { useStreaming } from '../../hooks/useStreaming';
import { useChatStore } from '../../store/chatStore';
import { messageService } from '../../services/messageService';
import { v4 as uuidv4 } from 'uuid';

export function ChatInput({ onAsk }: { onAsk: (prompt: string) => void }) {
    const [input, setInput] = useState('');
    const { isGenerating, cancel } = useStreaming();
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (!isGenerating && textareaRef.current) {
            textareaRef.current.focus();
        }
    }, [isGenerating]);

    const handleSubmit = () => {
        if (!input.trim() || isGenerating) return;
        const prompt = input;
        setInput('');
        onAsk(prompt);
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
        if (e.key === 'Escape' && isGenerating) {
            cancel();
        }
    };

    return (
        <div className="w-full max-w-3xl mx-auto px-4 pb-0 pt-0">
            <div className="relative flex items-end bg-[#2f2f2f] rounded-2xl focus-within:ring-1 focus-within:ring-neutral-500 overflow-hidden shadow-lg pl-3 pr-2 py-2 mb-2">
                <ReactTextareaAutosize
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Message LLM..."
                    className="flex-1 max-h-[200px] min-h-[44px] bg-transparent text-neutral-100 placeholder-[#9b9b9b] border-0 outline-none focus:ring-0 resize-none py-3 px-1 text-base"
                    autoFocus
                />

                <div className="flex pl-3 pb-1 h-[44px] items-center">
                    {isGenerating ? (
                        <button
                            onClick={cancel}
                            className="p-2 bg-neutral-700 hover:bg-neutral-600 text-white rounded-xl transition-colors shrink-0"
                            title="Stop generating (Esc)"
                        >
                            <Square size={18} fill="currentColor" />
                        </button>
                    ) : (
                        <button
                            onClick={handleSubmit}
                            disabled={!input.trim()}
                            className="p-2 bg-white hover:bg-neutral-200 text-black disabled:bg-[#676767] disabled:text-[#2f2f2f] rounded-xl transition-colors shrink-0 flex items-center justify-center"
                            title="Send message (Enter)"
                        >
                            <ArrowUp size={20} strokeWidth={2.5} />
                        </button>
                    )}
                </div>
            </div>
            {/* The disclaimer is handled in ChatArea now, dropping it from here for cleaner embedding */}
        </div>
    );
}
