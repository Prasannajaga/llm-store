import ReactTextareaAutosize from 'react-textarea-autosize';
import { ArrowUp, Square, X } from 'lucide-react';
import { useState, useRef, useEffect, useCallback, memo, useMemo } from 'react';
import type { KeyboardEvent } from 'react';
import { useModelStore } from '../../store/modelStore';
import { knowledgeService } from '../../services/knowledgeService';
import type { KnowledgeDocument } from '../../types';

interface ChatInputProps {
    onAsk: (prompt: string, knowledgeDocumentIds: string[] | null) => Promise<void>;
    isGenerating?: boolean;
    onCancel?: () => Promise<void> | void;
}

export const ChatInput = memo(function ChatInput({ onAsk, isGenerating = false, onCancel }: ChatInputProps) {
    const [input, setInput] = useState('');
    const [knowledgeDocuments, setKnowledgeDocuments] = useState<KnowledgeDocument[]>([]);
    const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>([]);
    const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const isModelLoading = useModelStore((s) => s.isModelLoading);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const isBusy = isGenerating || isModelLoading || isSubmitting;
    const selectedKnowledgeDocuments = useMemo(
        () => knowledgeDocuments.filter((doc) => selectedKnowledgeIds.includes(doc.id)),
        [knowledgeDocuments, selectedKnowledgeIds],
    );
    const isSlashLookup = input.trimStart().startsWith('/') && !input.trimStart().slice(1).includes(' ');
    const slashQuery = isSlashLookup ? input.trimStart().slice(1).toLowerCase() : '';
    const knowledgeSuggestions = useMemo(
        () => knowledgeDocuments
            .filter((doc) => !selectedKnowledgeIds.includes(doc.id))
            .filter((doc) => doc.file_name.toLowerCase().includes(slashQuery)),
        [knowledgeDocuments, selectedKnowledgeIds, slashQuery],
    );
    const showSuggestionList = isSlashLookup && knowledgeSuggestions.length > 0;

    useEffect(() => {
        if (!isGenerating && textareaRef.current) {
            textareaRef.current.focus();
        }
    }, [isGenerating]);

    useEffect(() => {
        void knowledgeService.listDocuments()
            .then((docs) => {
                setKnowledgeDocuments(docs);
                setSelectedKnowledgeIds((prev) => prev.filter((id) => docs.some((doc) => doc.id === id)));
            })
            .catch((err) => {
                console.error('Failed to load knowledge documents for chat input:', err);
            });
    }, []);

    useEffect(() => {
        setActiveSuggestionIndex(0);
    }, [slashQuery]);

    const handleSelectKnowledge = useCallback((documentId: string) => {
        setSelectedKnowledgeIds((prev) => {
            if (prev.includes(documentId)) {
                return prev;
            }
            return [...prev, documentId];
        });
        setInput('');
        setActiveSuggestionIndex(0);
        textareaRef.current?.focus();
    }, []);

    const handleRemoveKnowledge = useCallback((documentId: string) => {
        setSelectedKnowledgeIds((prev) => prev.filter((id) => id !== documentId));
    }, []);

    const handleSubmit = useCallback(async () => {
        const prompt = input.trim();
        if (!prompt || isBusy || isSlashLookup) return;
        setIsSubmitting(true);
        setInput('');
        try {
            await onAsk(prompt, selectedKnowledgeIds.length > 0 ? selectedKnowledgeIds : null);
        } catch (err) {
            console.error('Failed to submit message:', err);
            setInput(prompt);
        } finally {
            setIsSubmitting(false);
        }
    }, [input, isBusy, isSlashLookup, onAsk, selectedKnowledgeIds]);

    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (showSuggestionList) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveSuggestionIndex((prev) => (prev + 1) % knowledgeSuggestions.length);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveSuggestionIndex((prev) => (prev - 1 + knowledgeSuggestions.length) % knowledgeSuggestions.length);
                return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const selected = knowledgeSuggestions[activeSuggestionIndex];
                if (selected) {
                    handleSelectKnowledge(selected.id);
                }
                return;
            }
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void handleSubmit();
        }
        if (e.key === 'Escape' && isGenerating && onCancel) {
            void onCancel();
        }
    }, [activeSuggestionIndex, handleSelectKnowledge, handleSubmit, isGenerating, knowledgeSuggestions, onCancel, showSuggestionList]);

    return (
        <div className="w-full max-w-4xl mx-auto">
            <div className="relative glass-panel focus-within:ring-2 focus-within:ring-indigo-500/50 shadow-2xl pl-5 pr-3 py-2.5 mb-2 transition-all duration-300 rounded-[24px]">
                <div className="flex flex-wrap items-center gap-2 px-1 pt-1 pb-2">
                    {selectedKnowledgeDocuments.length === 0 ? (
                        <span className="inline-flex items-center rounded-full border border-neutral-700 bg-neutral-800/60 px-2.5 py-1 text-[11px] text-neutral-300">
                            No knowledge selected
                        </span>
                    ) : (
                        selectedKnowledgeDocuments.map((doc) => (
                            <span
                                key={doc.id}
                                className="inline-flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1 text-[11px] text-indigo-200"
                            >
                                {doc.file_name}
                                <button
                                    onClick={() => handleRemoveKnowledge(doc.id)}
                                    className="rounded-full p-0.5 hover:bg-indigo-500/25 transition-colors"
                                    title={`Remove ${doc.file_name}`}
                                >
                                    <X size={12} />
                                </button>
                            </span>
                        ))
                    )}
                </div>

                {showSuggestionList && (
                    <div className="absolute left-4 right-4 bottom-[calc(100%+8px)] z-20 rounded-xl border border-neutral-700 bg-[#1f1f1f] shadow-2xl overflow-hidden">
                        <div className="px-3 py-2 text-[11px] text-neutral-400 border-b border-neutral-700/70">
                            Knowledge files
                        </div>
                        <div className="max-h-48 overflow-y-auto py-1">
                            {knowledgeSuggestions.map((doc, index) => (
                                <button
                                    key={doc.id}
                                    onClick={() => handleSelectKnowledge(doc.id)}
                                    className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                                        index === activeSuggestionIndex
                                            ? 'bg-indigo-500/20 text-indigo-100'
                                            : 'text-neutral-200 hover:bg-neutral-800'
                                    }`}
                                >
                                    <div className="truncate">{doc.file_name}</div>
                                    <div className="text-[11px] text-neutral-500 mt-0.5">{doc.chunk_count} chunks</div>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                <div className="relative flex items-end">
                <ReactTextareaAutosize
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={isModelLoading || isSubmitting}
                    placeholder={isModelLoading ? "Waiting for model to load..." : "Message LLM... (type / to choose knowledge)"}
                    className="flex-1 max-h-[200px] min-h-[44px] bg-transparent text-neutral-100 placeholder-neutral-400 border-0 outline-none focus:ring-0 resize-none py-3 px-1 text-base leading-relaxed scrollbar-thin scrollbar-thumb-neutral-600 disabled:opacity-50"
                    autoFocus
                />

                <div className="flex pl-3 pb-1.5 h-[48px] items-center">
                    {isGenerating ? (
                        <button
                            onClick={() => void onCancel?.()}
                            className="p-2.5 bg-neutral-700/80 hover:bg-neutral-600 text-white rounded-full transition-colors duration-150 shrink-0 shadow-sm flex items-center justify-center"
                            title="Stop generating (Esc)"
                        >
                            <Square size={16} fill="currentColor" />
                        </button>
                    ) : (
                        <button
                            onClick={() => void handleSubmit()}
                            disabled={!input.trim() || isBusy || isSlashLookup}
                            className={`p-2.5 bg-white hover:bg-neutral-200 text-black disabled:bg-white/10 disabled:text-white/30 rounded-full transition-colors duration-150 shrink-0 flex items-center justify-center shadow-sm ${(isBusy || isSlashLookup) ? 'cursor-not-allowed opacity-50' : ''}`}
                            title={isModelLoading ? 'Model is loading...' : 'Send message (Enter)'}
                        >
                            <ArrowUp size={18} strokeWidth={3} />
                        </button>
                    )}
                </div>
                </div>
            </div>
        </div>
    );
});
