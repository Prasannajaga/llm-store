import ReactTextareaAutosize from 'react-textarea-autosize';
import { ArrowUp, Square } from 'lucide-react';
import { useState, useRef, useEffect, useCallback, memo } from 'react';
import type { KeyboardEvent } from 'react';
import { useModelStore } from '../../store/modelStore';

interface ChatInputProps {
    onAsk: (prompt: string) => void;
    isGenerating?: boolean;
    onCancel?: () => void;
}

export const ChatInput = memo(function ChatInput({ onAsk, isGenerating = false, onCancel }: ChatInputProps) {
    const [input, setInput] = useState('');
    const isModelLoading = useModelStore((s) => s.isModelLoading);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (!isGenerating && textareaRef.current) {
            textareaRef.current.focus();
        }
    }, [isGenerating]);

    const handleSubmit = useCallback(() => {
        if (!input.trim() || isGenerating || isModelLoading) return;
        const prompt = input;
        setInput('');
        onAsk(prompt);
    }, [input, isGenerating, isModelLoading, onAsk]);

    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
        if (e.key === 'Escape' && isGenerating && onCancel) {
            onCancel();
        }
    }, [handleSubmit, isGenerating, onCancel]);

    return (
        <div className="w-full max-w-3xl mx-auto px-4 pb-0 pt-0">
            <div className="relative flex items-end glass-panel focus-within:ring-2 focus-within:ring-indigo-500/50 shadow-2xl pl-5 pr-3 py-2.5 mb-2 transition-all duration-300 rounded-[24px]">
                <ReactTextareaAutosize
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={isModelLoading}
                    placeholder={isModelLoading ? "Waiting for model to load..." : "Message LLM..."}
                    className="flex-1 max-h-[200px] min-h-[44px] bg-transparent text-neutral-100 placeholder-neutral-400 border-0 outline-none focus:ring-0 resize-none py-3 px-1 text-base leading-relaxed scrollbar-thin scrollbar-thumb-neutral-600 disabled:opacity-50"
                    autoFocus
                />

                <div className="flex pl-3 pb-1.5 h-[48px] items-center">
                    {isGenerating ? (
                        <button
                            onClick={onCancel}
                            className="p-2.5 bg-neutral-700/80 hover:bg-neutral-600 text-white rounded-full transition-colors duration-150 shrink-0 shadow-sm flex items-center justify-center"
                            title="Stop generating (Esc)"
                        >
                            <Square size={16} fill="currentColor" />
                        </button>
                    ) : (
                        <button
                            onClick={handleSubmit}
                            disabled={!input.trim() || isModelLoading}
                            className={`p-2.5 bg-white hover:bg-neutral-200 text-black disabled:bg-white/10 disabled:text-white/30 rounded-full transition-colors duration-150 shrink-0 flex items-center justify-center shadow-sm ${isModelLoading ? 'cursor-not-allowed opacity-50' : ''}`}
                            title={isModelLoading ? 'Model is loading...' : 'Send message (Enter)'}
                        >
                            <ArrowUp size={18} strokeWidth={3} />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
});
