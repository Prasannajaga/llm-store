import { ArrowUp, Database, Plus, Search, Square, X } from 'lucide-react';
import { useState, useRef, useEffect, useCallback, memo, useMemo, useDeferredValue } from 'react';
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useModelStore } from '../../store/modelStore';
import { useSettingsStore } from '../../store/settingsStore';
import { knowledgeService } from '../../services/knowledgeService';
import type { KnowledgeDocument } from '../../types';
import { CheckboxOptionRow } from '../ui/CheckboxOptionRow';
import { IconButton } from '../ui/IconButton';
import { TextInput } from '../ui/TextInput';
import { AutosizeTextInput } from '../ui/AutosizeTextInput';
import { ThinkingModeSwitch } from '../ui/ThinkingModeSwitch';
import { Button } from '../ui/Button';

interface ChatInputProps {
    onAsk: (prompt: string, knowledgeDocumentIds: string[] | null) => Promise<void>;
    isGenerating?: boolean;
    onCancel?: () => Promise<void> | void;
    contextWindow?: {
        usedTokens: number;
        maxTokens: number;
        contextText: string;
    } | null;
}

export const ChatInput = memo(function ChatInput({
    onAsk,
    isGenerating = false,
    onCancel,
    contextWindow = null,
}: ChatInputProps) {
    const [input, setInput] = useState('');
    const [knowledgeDocuments, setKnowledgeDocuments] = useState<KnowledgeDocument[]>([]);
    const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>([]);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isQuickMenuOpen, setIsQuickMenuOpen] = useState(false);
    const [isContextPopoverOpen, setIsContextPopoverOpen] = useState(false);
    const [quickMenuQuery, setQuickMenuQuery] = useState('');
    const [isKnowledgeLoading, setIsKnowledgeLoading] = useState(false);
    const [hasKnowledgeLoaded, setHasKnowledgeLoaded] = useState(false);

    const isModelLoading = useModelStore((s) => s.isModelLoading);
    const thinkingModeEnabled = useSettingsStore((s) => s.generation.thinkingMode);
    const agentModeEnabled = useSettingsStore((s) => s.generation.agentMode);
    const setThinkingMode = useSettingsStore((s) => s.setThinkingMode);
    const setAgentMode = useSettingsStore((s) => s.setAgentMode);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const quickMenuRef = useRef<HTMLDivElement>(null);
    const contextPopoverRef = useRef<HTMLDivElement>(null);
    const isBusy = isGenerating || isModelLoading || isSubmitting;
    const selectedKnowledgeIdSet = useMemo(
        () => new Set(selectedKnowledgeIds),
        [selectedKnowledgeIds],
    );
    const deferredQuickMenuQuery = useDeferredValue(quickMenuQuery);

    const selectedKnowledgeDocuments = useMemo(
        () => {
            if (selectedKnowledgeIds.length === 0) {
                return [];
            }
            return knowledgeDocuments.filter((doc) => selectedKnowledgeIdSet.has(doc.id));
        },
        [knowledgeDocuments, selectedKnowledgeIdSet, selectedKnowledgeIds.length],
    );

    const filteredKnowledgeDocuments = useMemo(() => {
        const query = deferredQuickMenuQuery.trim().toLowerCase();
        if (!query) {
            return knowledgeDocuments;
        }
        return knowledgeDocuments.filter((doc) => doc.file_name.toLowerCase().includes(query));
    }, [deferredQuickMenuQuery, knowledgeDocuments]);

    const allFilteredSelected = useMemo(() => {
        if (filteredKnowledgeDocuments.length === 0) {
            return false;
        }
        return filteredKnowledgeDocuments.every((doc) => selectedKnowledgeIdSet.has(doc.id));
    }, [filteredKnowledgeDocuments, selectedKnowledgeIdSet]);

    useEffect(() => {
        if (!isGenerating && textareaRef.current) {
            textareaRef.current.focus();
        }
    }, [isGenerating]);

    const loadKnowledgeDocuments = useCallback(async () => {
        if (isKnowledgeLoading || hasKnowledgeLoaded) {
            return;
        }
        setIsKnowledgeLoading(true);
        try {
            const docs = await knowledgeService.listDocuments();
            setKnowledgeDocuments(docs);
            setSelectedKnowledgeIds((prev) => prev.filter((id) => docs.some((doc) => doc.id === id)));
            setHasKnowledgeLoaded(true);
        } catch (err) {
            console.error('Failed to load knowledge documents for chat input:', err);
        } finally {
            setIsKnowledgeLoading(false);
        }
    }, [hasKnowledgeLoaded, isKnowledgeLoading]);

    useEffect(() => {
        if (!isQuickMenuOpen || hasKnowledgeLoaded) {
            return;
        }
        void loadKnowledgeDocuments();
    }, [hasKnowledgeLoaded, isQuickMenuOpen, loadKnowledgeDocuments]);

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

    useEffect(() => {
        if (!isContextPopoverOpen) {
            return;
        }

        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (contextPopoverRef.current?.contains(target)) return;
            setIsContextPopoverOpen(false);
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isContextPopoverOpen]);

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
        if (!isQuickMenuOpen && !hasKnowledgeLoaded) {
            void loadKnowledgeDocuments();
        }
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
    const handleThinkingModeChange = useCallback((checked: boolean) => {
        void setThinkingMode(checked);
    }, [setThinkingMode]);
    const handleAgentModeChange = useCallback((checked: boolean) => {
        void setAgentMode(checked);
    }, [setAgentMode]);

    const contextMaxTokens = Math.max(1, contextWindow?.maxTokens ?? 1);
    const contextUsedTokensRaw = Math.max(0, contextWindow?.usedTokens ?? 0);
    const contextUsedTokens = Math.min(contextUsedTokensRaw, contextMaxTokens);
    const contextUsedPercent = Math.max(0, Math.min(100, Math.round((contextUsedTokens / contextMaxTokens) * 100)));
    const contextLeftPercent = Math.max(0, 100 - contextUsedPercent);
    const contextText = contextWindow?.contextText?.trim() ?? '';

    const quickMenuContainerClass = isQuickMenuOpen
        ? 'opacity-100 translate-y-0 pointer-events-auto'
        : 'opacity-0 translate-y-2 pointer-events-none';
    const quickToggleClass = isQuickMenuOpen
        ? 'border-neutral-500/70'
        : 'border-neutral-600/70';

    return (
        <div className="w-full">
            <div className="relative border border-neutral-700 bg-[var(--surface-elevated)] pl-4 pr-3 py-2.5 mb-2 transition-colors duration-200 rounded-2xl focus-within:border-neutral-600">
                {selectedKnowledgeDocuments.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 px-1 pt-1 pb-2">
                        {selectedKnowledgeDocuments.map((doc) => (
                            <span
                                key={doc.id}
                                className="inline-flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1 text-[11px] text-indigo-200"
                            >
                                {doc.file_name}
                                <IconButton
                                    onClick={() => handleRemoveKnowledge(doc.id)}
                                    icon={<X size={12} />}
                                    ariaLabel={`Remove ${doc.file_name}`}
                                    tone="brand"
                                    size="xs"
                                    shape="circle"
                                />
                            </span>
                        ))}
                    </div>
                )}

                <div className="relative flex items-end">
                    <div className="relative flex items-end pb-1.5 pr-2 shrink-0" ref={quickMenuRef}>
                        <IconButton
                            onClick={handleQuickMenuToggle}
                            icon={<Plus size={16} />}
                            ariaLabel="Knowledge & tools"
                            tone="neutral"
                            size="lg"
                            shape="circle"
                            active={isQuickMenuOpen}
                            className={`border transition-all duration-150 ${quickToggleClass}`}
                        />

                        <div className={`absolute left-0 bottom-[calc(100%+10px)] z-20 w-[20rem] max-w-[calc(100vw-1.5rem)] max-h-[min(68vh,31rem)] rounded-xl border border-neutral-600/60 bg-[var(--surface-popover)] shadow-lg overflow-hidden transition-all duration-150 flex flex-col ${quickMenuContainerClass}`}>
                            <div className="flex items-center justify-between px-3.5 py-3 border-b border-neutral-600/50">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium text-neutral-100">Quick Tools</div>
                                    <div className="text-[11px] text-neutral-400">
                                        {selectedCount} knowledge file{selectedCount === 1 ? '' : 's'} selected
                                    </div>
                                </div>
                                <IconButton
                                    onClick={handleQuickMenuClose}
                                    icon={<X size={14} />}
                                    ariaLabel="Close tools"
                                    size="xs"
                                />
                            </div>

                            <div className="px-3.5 py-3 border-b border-neutral-600/50">
                                <ThinkingModeSwitch
                                    checked={thinkingModeEnabled}
                                    onCheckedChange={handleThinkingModeChange}
                                    label="Thinking mode"
                                    description="Show reasoning stream while the model responds"
                                    size="md"
                                    className="rounded-lg border border-neutral-600/60 bg-[var(--surface-input)] px-3 py-2.5"
                                />
                                <ThinkingModeSwitch
                                    checked={agentModeEnabled}
                                    onCheckedChange={handleAgentModeChange}
                                    label="Agent mode"
                                    description="Enable tool-using agent workflow"
                                    size="md"
                                    className="mt-2 rounded-lg border border-neutral-600/60 bg-[var(--surface-input)] px-3 py-2.5"
                                />
                            </div>

                            <div className="px-3.5 py-3 border-b border-neutral-600/50">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="inline-flex items-center gap-1.5 text-xs text-neutral-300">
                                        <Database size={13} />
                                        Knowledge
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Button
                                            onClick={handleSelectAllFiltered}
                                            disabled={!hasKnowledgeDocs || allFilteredSelected}
                                            variant="ghost"
                                            size="sm"
                                        >
                                            Select all
                                        </Button>
                                        <Button
                                            onClick={handleClearKnowledge}
                                            disabled={selectedCount === 0}
                                            variant="ghost"
                                            size="sm"
                                        >
                                            Clear
                                        </Button>
                                    </div>
                                </div>
                                <TextInput
                                    containerClassName="mt-2.5"
                                    value={quickMenuQuery}
                                    onChange={(e) => setQuickMenuQuery(e.target.value)}
                                    placeholder="Search knowledge files..."
                                    leftAdornment={<Search size={13} />}
                                    inputSize="sm"
                                    className="bg-[var(--surface-input)]"
                                />
                            </div>

                            <div className="flex-1 min-h-0 overflow-y-auto pb-1">
                                {isKnowledgeLoading ? (
                                    <div className="px-3.5 py-4 text-xs text-neutral-500">
                                        Loading knowledge documents...
                                    </div>
                                ) : !hasKnowledgeDocs ? (
                                    <div className="px-3.5 py-4 text-xs text-neutral-500">
                                        No knowledge documents indexed yet.
                                    </div>
                                ) : emptySearch ? (
                                    <div className="px-3.5 py-4 text-xs text-neutral-500">
                                        No files match "{quickMenuQuery.trim()}".
                                    </div>
                                ) : (
                                    filteredKnowledgeDocuments.map((doc) => {
                                        const checked = selectedKnowledgeIdSet.has(doc.id);
                                        return (
                                            <div
                                                key={doc.id}
                                                className="px-3.5 py-1.5"
                                            >
                                                <CheckboxOptionRow
                                                    checked={checked}
                                                    title={doc.file_name}
                                                    description={`${doc.chunk_count} chunks`}
                                                    onChange={() => handleToggleKnowledge(doc.id)}
                                                />
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        </div>
                    </div>

                    <AutosizeTextInput
                        ref={textareaRef}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        disabled={isModelLoading || isSubmitting}
                        placeholder={isModelLoading ? 'Waiting for model to load...' : 'Message LLM...'}
                        variant="embedded"
                        className="flex-1 max-h-[200px] min-h-[44px] resize-none py-3 px-1 text-base leading-relaxed scrollbar-thin scrollbar-thumb-neutral-600"
                        autoFocus
                    />

                    <div className="flex pl-3 pb-1.5 h-[48px] items-center gap-1.5">
                        <div className="relative" ref={contextPopoverRef}>
                            <button
                                type="button"
                                onClick={() => setIsContextPopoverOpen((prev) => !prev)}
                                className="inline-flex items-center gap-1.5 rounded-full border border-neutral-700/80 bg-neutral-900/30 px-2 py-1 text-[10px] text-neutral-300 hover:bg-neutral-800/60 transition-colors"
                                aria-label="Show context window details"
                            >
                                <span className="inline-flex h-2 w-2 rounded-full bg-sky-400" />
                                <span>{contextUsedPercent}%</span>
                            </button>

                            {isContextPopoverOpen && (
                                <div className="absolute right-0 bottom-[calc(100%+8px)] z-30 w-[18rem] max-w-[calc(100vw-1.5rem)] rounded-lg border border-neutral-600/70 bg-[var(--surface-popover)] shadow-lg p-2.5 space-y-2">
                                    <div className="text-xs text-neutral-300 leading-relaxed">
                                        <div>
                                            Context: {contextUsedPercent}% used ({contextLeftPercent}% left)
                                        </div>
                                        <div className="text-neutral-400">
                                            {contextUsedTokens.toLocaleString()} / {contextMaxTokens.toLocaleString()} tokens
                                        </div>
                                    </div>

                                    <details className="text-xs text-neutral-400">
                                        <summary className="cursor-pointer select-none hover:text-neutral-200 transition-colors">
                                            Full compacted context
                                        </summary>
                                        <div className="mt-1.5 rounded border border-neutral-700/80 bg-neutral-950/60 p-2 max-h-44 overflow-y-auto">
                                            {contextText ? (
                                                <pre className="whitespace-pre-wrap text-[11px] text-neutral-300 leading-relaxed m-0 font-sans">
                                                    {contextText}
                                                </pre>
                                            ) : (
                                                <p className="text-[11px] text-neutral-500 m-0">
                                                    No prior conversation context yet.
                                                </p>
                                            )}
                                        </div>
                                    </details>
                                </div>
                            )}
                        </div>

                        {isGenerating ? (
                            <IconButton
                                onClick={() => void onCancel?.()}
                                icon={<Square size={16} fill="currentColor" />}
                                ariaLabel="Stop generating (Esc)"
                                size="lg"
                                shape="circle"
                                className="bg-neutral-700/80 hover:bg-neutral-600 text-white shadow-sm"
                            />
                        ) : (
                            <IconButton
                                onClick={() => void handleSubmit()}
                                disabled={!input.trim() || isBusy}
                                icon={<ArrowUp size={18} strokeWidth={3} />}
                                ariaLabel={isModelLoading ? 'Model is loading...' : 'Send message (Enter)'}
                                tone="brand"
                                size="lg"
                                shape="circle"
                                active
                                className="bg-white text-black hover:bg-neutral-200 disabled:bg-white/10 disabled:text-white/30 shadow-sm"
                            />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
});
