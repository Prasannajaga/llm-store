import ReactTextareaAutosize from 'react-textarea-autosize';
import { ArrowUp, Brain, Database, Plus, Search, Square, X } from 'lucide-react';
import { useState, useRef, useEffect, useCallback, memo, useMemo } from 'react';
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useModelStore } from '../../store/modelStore';
import { useSettingsStore } from '../../store/settingsStore';
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
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isQuickMenuOpen, setIsQuickMenuOpen] = useState(false);
    const [quickMenuQuery, setQuickMenuQuery] = useState('');

    const isModelLoading = useModelStore((s) => s.isModelLoading);
    const thinkingModeEnabled = useSettingsStore((s) => s.generation.thinkingMode);
    const setThinkingMode = useSettingsStore((s) => s.setThinkingMode);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const quickMenuRef = useRef<HTMLDivElement>(null);
    const isBusy = isGenerating || isModelLoading || isSubmitting;

    const selectedKnowledgeDocuments = useMemo(
        () => knowledgeDocuments.filter((doc) => selectedKnowledgeIds.includes(doc.id)),
        [knowledgeDocuments, selectedKnowledgeIds],
    );

    const filteredKnowledgeDocuments = useMemo(() => {
        const query = quickMenuQuery.trim().toLowerCase();
        if (!query) {
            return knowledgeDocuments;
        }
        return knowledgeDocuments.filter((doc) => doc.file_name.toLowerCase().includes(query));
    }, [knowledgeDocuments, quickMenuQuery]);

    const allFilteredSelected = useMemo(() => {
        if (filteredKnowledgeDocuments.length === 0) {
            return false;
        }
        return filteredKnowledgeDocuments.every((doc) => selectedKnowledgeIds.includes(doc.id));
    }, [filteredKnowledgeDocuments, selectedKnowledgeIds]);

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
        if (!isQuickMenuOpen) {
            return;
        }

        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (quickMenuRef.current?.contains(target)) return;
            setIsQuickMenuOpen(false);
            setQuickMenuQuery('');
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isQuickMenuOpen]);

    const handleToggleKnowledge = useCallback((documentId: string) => {
        setSelectedKnowledgeIds((prev) => {
            if (prev.includes(documentId)) {
                return prev.filter((id) => id !== documentId);
            }
            return [...prev, documentId];
        });
    }, []);

    const handleRemoveKnowledge = useCallback((documentId: string) => {
        setSelectedKnowledgeIds((prev) => prev.filter((id) => id !== documentId));
    }, []);

    const handleSelectAllFiltered = useCallback(() => {
        if (filteredKnowledgeDocuments.length === 0) {
            return;
        }
        setSelectedKnowledgeIds((prev) => {
            const next = new Set(prev);
            for (const doc of filteredKnowledgeDocuments) {
                next.add(doc.id);
            }
            return Array.from(next);
        });
    }, [filteredKnowledgeDocuments]);

    const handleClearKnowledge = useCallback(() => {
        setSelectedKnowledgeIds([]);
    }, []);

    const handleSubmit = useCallback(async () => {
        const prompt = input.trim();
        if (!prompt || isBusy) return;
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
    }, [input, isBusy, onAsk, selectedKnowledgeIds]);

    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void handleSubmit();
        }
        if (e.key === 'Escape' && isGenerating && onCancel) {
            void onCancel();
        }
    }, [handleSubmit, isGenerating, onCancel]);

    const handleQuickMenuToggle = (event: ReactMouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        setIsQuickMenuOpen((prev) => !prev);
        setQuickMenuQuery('');
    };

    const handleQuickMenuClose = () => {
        setIsQuickMenuOpen(false);
        setQuickMenuQuery('');
    };

    const selectedCount = selectedKnowledgeIds.length;
    const hasKnowledgeDocs = knowledgeDocuments.length > 0;
    const emptySearch = hasKnowledgeDocs && filteredKnowledgeDocuments.length === 0;

    const quickMenuContainerClass = isQuickMenuOpen
        ? 'opacity-100 translate-y-0 pointer-events-auto'
        : 'opacity-0 translate-y-2 pointer-events-none';
    const quickToggleClass = isQuickMenuOpen
        ? 'bg-neutral-700/70 text-neutral-100 border-neutral-500/70'
        : 'bg-neutral-700/40 hover:bg-neutral-700/60 text-neutral-300 border-neutral-600/70';

    return (
        <div className="w-full max-w-4xl mx-auto">
            <div className="relative glass-panel focus-within:ring-2 focus-within:ring-indigo-500/50 shadow-2xl pl-4 pr-3 py-2.5 mb-2 transition-all duration-300 rounded-[24px]">
                {selectedKnowledgeDocuments.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 px-1 pt-1 pb-2">
                        {selectedKnowledgeDocuments.map((doc) => (
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
                        ))}
                    </div>
                )}

                <div className="relative flex items-end">
                    <div className="relative flex items-end pb-1.5 pr-2 shrink-0" ref={quickMenuRef}>
                        <button
                            onClick={handleQuickMenuToggle}
                            className={`p-2.5 rounded-full border transition-all duration-150 ${quickToggleClass}`}
                            title="Knowledge & tools"
                            aria-label="Knowledge & tools"
                        >
                            <Plus size={16} />
                        </button>

                        <div className={`absolute left-0 bottom-[calc(100%+10px)] z-20 w-[20rem] max-w-[calc(100vw-1.5rem)] max-h-[min(68vh,31rem)] rounded-xl border border-neutral-600/60 bg-[#2a2a2a] shadow-lg overflow-hidden transition-all duration-150 flex flex-col ${quickMenuContainerClass}`}>
                            <div className="flex items-center justify-between px-3.5 py-3 border-b border-neutral-600/50">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium text-neutral-100">Quick Tools</div>
                                    <div className="text-[11px] text-neutral-400">
                                        {selectedCount} knowledge file{selectedCount === 1 ? '' : 's'} selected
                                    </div>
                                </div>
                                <button
                                    onClick={handleQuickMenuClose}
                                    className="p-1 rounded-md text-neutral-400 hover:text-neutral-100 hover:bg-neutral-600/40 transition-colors"
                                    title="Close tools"
                                    aria-label="Close tools"
                                >
                                    <X size={14} />
                                </button>
                            </div>

                            <div className="px-3.5 py-3 border-b border-neutral-600/50">
                                <div className="flex items-center justify-between gap-3 rounded-lg border border-neutral-600/60 bg-[#303030] px-3 py-2.5">
                                    <div className="flex items-start gap-2 min-w-0">
                                        <span className="mt-0.5 text-neutral-300">
                                            <Brain size={14} />
                                        </span>
                                        <div className="min-w-0">
                                            <div className="text-sm text-neutral-100 font-medium">Thinking mode</div>
                                            <div className="text-[11px] text-neutral-400">Show reasoning stream while the model responds</div>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={thinkingModeEnabled}
                                        onClick={() => void setThinkingMode(!thinkingModeEnabled)}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${thinkingModeEnabled ? 'bg-neutral-500' : 'bg-neutral-600'}`}
                                    >
                                        <span
                                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${thinkingModeEnabled ? 'translate-x-6' : 'translate-x-1'}`}
                                        />
                                    </button>
                                </div>
                            </div>

                            <div className="px-3.5 py-3 border-b border-neutral-600/50">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="inline-flex items-center gap-1.5 text-xs text-neutral-300">
                                        <Database size={13} />
                                        Knowledge
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={handleSelectAllFiltered}
                                            disabled={!hasKnowledgeDocs || allFilteredSelected}
                                            className="text-[11px] px-2 py-1 rounded-md border border-neutral-600 text-neutral-300 hover:bg-neutral-600/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                        >
                                            Select all
                                        </button>
                                        <button
                                            onClick={handleClearKnowledge}
                                            disabled={selectedCount === 0}
                                            className="text-[11px] px-2 py-1 rounded-md border border-neutral-600 text-neutral-300 hover:bg-neutral-600/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                        >
                                            Clear
                                        </button>
                                    </div>
                                </div>
                                <div className="relative mt-2.5">
                                    <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
                                    <input
                                        value={quickMenuQuery}
                                        onChange={(e) => setQuickMenuQuery(e.target.value)}
                                        placeholder="Search knowledge files..."
                                        className="w-full h-9 rounded-lg border border-neutral-600 bg-[#303030] pl-8 pr-3 text-sm text-neutral-100 placeholder:text-neutral-500 outline-none focus:border-neutral-400 focus:ring-1 focus:ring-neutral-500/20 transition-colors"
                                    />
                                </div>
                            </div>

                            <div className="flex-1 min-h-0 overflow-y-auto pb-1">
                                {!hasKnowledgeDocs ? (
                                    <div className="px-3.5 py-4 text-xs text-neutral-500">
                                        No knowledge documents indexed yet.
                                    </div>
                                ) : emptySearch ? (
                                    <div className="px-3.5 py-4 text-xs text-neutral-500">
                                        No files match "{quickMenuQuery.trim()}".
                                    </div>
                                ) : (
                                    filteredKnowledgeDocuments.map((doc) => {
                                        const checked = selectedKnowledgeIds.includes(doc.id);
                                        return (
                                            <label
                                                key={doc.id}
                                                className="flex items-start gap-2.5 px-3.5 py-2.5 text-sm text-neutral-200 hover:bg-neutral-600/25 cursor-pointer transition-colors"
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={() => handleToggleKnowledge(doc.id)}
                                                    className="mt-0.5 h-4 w-4 rounded border-neutral-500 bg-neutral-800 text-neutral-300 focus:ring-neutral-500"
                                                />
                                                <span className="min-w-0">
                                                    <span className="block truncate">{doc.file_name}</span>
                                                    <span className="block text-[11px] text-neutral-500">{doc.chunk_count} chunks</span>
                                                </span>
                                            </label>
                                        );
                                    })
                                )}
                            </div>
                        </div>
                    </div>

                    <ReactTextareaAutosize
                        ref={textareaRef}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        disabled={isModelLoading || isSubmitting}
                        placeholder={isModelLoading ? 'Waiting for model to load...' : 'Message LLM...'}
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
                                disabled={!input.trim() || isBusy}
                                className={`p-2.5 bg-white hover:bg-neutral-200 text-black disabled:bg-white/10 disabled:text-white/30 rounded-full transition-colors duration-150 shrink-0 flex items-center justify-center shadow-sm ${isBusy ? 'cursor-not-allowed opacity-50' : ''}`}
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
