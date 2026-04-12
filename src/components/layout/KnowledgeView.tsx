import { useCallback, useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { BookText, Loader2, Maximize2, Plus, Search, Trash2, X } from 'lucide-react';
import { knowledgeService } from '../../services/knowledgeService';
import type { KnowledgeDocument, KnowledgeSearchResult } from '../../types';
import { MermaidBlock } from '../message/MermaidBlock';
import { IconButton } from '../ui/IconButton';
import { TextInput } from '../ui/TextInput';
import { Checkbox } from '../ui/Checkbox';

const FILE_EXTENSIONS = [
    'txt', 'md', 'markdown', 'json', 'csv', 'pdf', 'docx',
    'js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'java', 'c', 'cpp',
    'html', 'css', 'xml', 'yaml', 'yml', 'toml',
];

function formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) {
        return dateStr;
    }
    return date.toLocaleString();
}

function previewText(content: string, maxChars = 160): string {
    const compact = content.split(/\s+/).filter(Boolean).join(' ');
    if (compact.length <= maxChars) {
        return compact || '(empty chunk)';
    }
    return `${compact.slice(0, maxChars).trimEnd()}...`;
}

const INGEST_STAGES = [
    'Reading file',
    'Chunking content',
    'Building embeddings',
    'Saving vectors',
] as const;

const GRAPH_MAX_NODES = 24;
const GRAPH_MAX_LEXICAL_EDGES = 30;
const GRAPH_MIN_JACCARD = 0.14;

function fileNameFromPath(path: string): string {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
}

function graphTokenSet(text: string): Set<string> {
    const tokens = text.match(/[A-Za-z0-9]+/g) ?? [];
    const set = new Set<string>();
    for (const rawToken of tokens) {
        const token = rawToken.toLowerCase();
        if (token.length >= 2) {
            set.add(token);
        }
    }
    return set;
}

function overlapJaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) {
        return 0;
    }

    let overlap = 0;
    const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
    for (const token of smaller) {
        if (larger.has(token)) {
            overlap += 1;
        }
    }

    if (overlap === 0) {
        return 0;
    }

    const union = a.size + b.size - overlap;
    if (union <= 0) {
        return 0;
    }

    return overlap / union;
}

function cleanMermaidLabel(value: string): string {
    return value
        .replace(/"/g, '\'')
        .replace(/\|/g, '/')
        .replace(/[\r\n]+/g, ' ')
        .trim();
}

interface GraphDiagramData {
    mermaid: string;
    totalNodes: number;
    renderedNodes: number;
    lexicalEdgeCount: number;
}

function buildGraphDiagram(
    chunks: KnowledgeSearchResult[],
    isShowingSearchResults: boolean,
): GraphDiagramData | null {
    if (chunks.length === 0) {
        return null;
    }

    const rendered = chunks.slice(0, GRAPH_MAX_NODES);
    const tokenSets = rendered.map((chunk) => graphTokenSet(chunk.content));

    const lines: string[] = ['graph LR'];
    for (let idx = 0; idx < rendered.length; idx += 1) {
        const chunk = rendered[idx];
        const prefix = isShowingSearchResults
            ? `#${idx + 1} score ${chunk.score.toFixed(2)}`
            : `Chunk ${idx + 1}`;
        const snippet = previewText(chunk.content, 60);
        const label = cleanMermaidLabel(`${prefix} ${snippet}`);
        lines.push(`n${idx}["${label}"]`);
    }

    for (let idx = 0; idx < rendered.length - 1; idx += 1) {
        lines.push(`n${idx} -- next --> n${idx + 1}`);
    }

    const lexicalEdges: Array<{ from: number; to: number; jaccard: number }> = [];
    for (let i = 0; i < rendered.length; i += 1) {
        for (let j = i + 1; j < rendered.length; j += 1) {
            if (j === i + 1) {
                continue;
            }
            const jaccard = overlapJaccard(tokenSets[i], tokenSets[j]);
            if (jaccard < GRAPH_MIN_JACCARD) {
                continue;
            }
            lexicalEdges.push({ from: i, to: j, jaccard });
        }
    }

    lexicalEdges.sort((a, b) => b.jaccard - a.jaccard);
    const selectedLexicalEdges = lexicalEdges.slice(0, GRAPH_MAX_LEXICAL_EDGES);
    for (const edge of selectedLexicalEdges) {
        const similarity = Math.round(edge.jaccard * 100);
        lines.push(`n${edge.from} -. "${similarity}% lexical" .-> n${edge.to}`);
    }

    return {
        mermaid: lines.join('\n'),
        totalNodes: chunks.length,
        renderedNodes: rendered.length,
        lexicalEdgeCount: selectedLexicalEdges.length,
    };
}

export function KnowledgeView() {
    const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
    const [results, setResults] = useState<KnowledgeSearchResult[]>([]);
    const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [topThreeOnly, setTopThreeOnly] = useState(true);
    const [searchMode, setSearchMode] = useState<'vector' | 'graph'>('vector');
    const [resultsViewMode, setResultsViewMode] = useState<'normal' | 'graph'>('normal');
    const [isLoadingDocs, setIsLoadingDocs] = useState(true);
    const [isUploading, setIsUploading] = useState(false);
    const [isSearching, setIsSearching] = useState(false);
    const [isShowingSearchResults, setIsShowingSearchResults] = useState(false);
    const [isGraphModalOpen, setIsGraphModalOpen] = useState(false);
    const [activeIngestFile, setActiveIngestFile] = useState<string | null>(null);
    const [activeIngestIndex, setActiveIngestIndex] = useState(0);
    const [activeIngestTotal, setActiveIngestTotal] = useState(0);
    const [activeIngestStage, setActiveIngestStage] = useState<(typeof INGEST_STAGES)[number]>(INGEST_STAGES[0]);
    const [status, setStatus] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const totalChunks = useMemo(
        () => documents.reduce((sum, doc) => sum + doc.chunk_count, 0),
        [documents],
    );
    const graphDiagram = useMemo(
        () => buildGraphDiagram(results, isShowingSearchResults),
        [results, isShowingSearchResults],
    );

    useEffect(() => {
        if (resultsViewMode !== 'graph') {
            setIsGraphModalOpen(false);
            return;
        }
        if (graphDiagram) {
            setIsGraphModalOpen(true);
        }
    }, [graphDiagram, resultsViewMode]);

    useEffect(() => {
        if (!isGraphModalOpen) {
            return;
        }
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsGraphModalOpen(false);
            }
        };
        window.addEventListener('keydown', handleEscape);
        return () => {
            window.removeEventListener('keydown', handleEscape);
        };
    }, [isGraphModalOpen]);

    const loadDocuments = useCallback(async () => {
        setIsLoadingDocs(true);
        try {
            const docs = await knowledgeService.listDocuments();
            setDocuments(docs);
            setSelectedDocumentId((prev) => {
                if (prev && docs.some((doc) => doc.id === prev)) {
                    return prev;
                }
                return docs[0]?.id ?? null;
            });
        } catch (err) {
            setError(`Failed to load knowledge documents: ${String(err)}`);
        } finally {
            setIsLoadingDocs(false);
        }
    }, []);

    useEffect(() => {
        void loadDocuments();
    }, [loadDocuments]);

    const loadAllChunks = useCallback(async (docId: string) => {
        setError(null);
        setIsSearching(true);
        try {
            const chunks = await knowledgeService.listDocumentChunks(docId);
            setResults(chunks);
            const selectedDoc = documents.find((doc) => doc.id === docId);
            const targetName = selectedDoc?.file_name ?? 'selected file';
            setStatus(`Showing ${chunks.length} chunk(s) from ${targetName}.`);
            setIsShowingSearchResults(false);
        } catch (err) {
            setError(`Failed to load chunks: ${String(err)}`);
        } finally {
            setIsSearching(false);
        }
    }, [documents]);

    useEffect(() => {
        if (!selectedDocumentId) {
            setResults([]);
            return;
        }
        if (query.trim()) {
            return;
        }
        if (isShowingSearchResults) {
            return;
        }
        void loadAllChunks(selectedDocumentId);
    }, [isShowingSearchResults, loadAllChunks, query, selectedDocumentId]);

    const handleUpload = async () => {
        setError(null);
        setStatus(null);
        try {
            const selected = await open({
                multiple: true,
                filters: [{ name: 'Knowledge Files', extensions: FILE_EXTENSIONS }],
            });

            const paths = Array.isArray(selected)
                ? selected.filter((path): path is string => typeof path === 'string')
                : (typeof selected === 'string' ? [selected] : []);

            if (paths.length === 0) return;

            setIsUploading(true);
            setActiveIngestTotal(paths.length);
            let ingestedChunks = 0;
            for (let index = 0; index < paths.length; index++) {
                const path = paths[index];
                const fileName = fileNameFromPath(path);
                setActiveIngestIndex(index + 1);
                setActiveIngestFile(fileName);
                setActiveIngestStage(INGEST_STAGES[0]);

                let stageIdx = 0;
                const stageTimer = setInterval(() => {
                    stageIdx = (stageIdx + 1) % INGEST_STAGES.length;
                    setActiveIngestStage(INGEST_STAGES[stageIdx]);
                }, 650);

                try {
                    const result = await knowledgeService.ingestFile(path);
                    ingestedChunks += result.chunks;
                } finally {
                    clearInterval(stageTimer);
                }
            }
            await loadDocuments();
            setStatus(`Indexed ${paths.length} file(s) into ${ingestedChunks} vector chunks.`);
        } catch (err) {
            setError(`Failed to ingest file(s): ${String(err)}`);
        } finally {
            setIsUploading(false);
            setActiveIngestFile(null);
            setActiveIngestIndex(0);
            setActiveIngestTotal(0);
            setActiveIngestStage(INGEST_STAGES[0]);
        }
    };

    const runSearch = useCallback(async (docId: string) => {
        setError(null);
        if (!query.trim()) {
            await loadAllChunks(docId);
            return;
        }
        setIsSearching(true);
        try {
            const hits = searchMode === 'graph'
                ? await knowledgeService.searchGraph(query.trim(), {
                    documentId: docId,
                    topThreeOnly,
                    limit: topThreeOnly ? 3 : 8,
                })
                : await knowledgeService.searchVector(query.trim(), {
                documentId: docId,
                topThreeOnly,
                limit: topThreeOnly ? 3 : 8,
            });
            setResults(hits);
            setIsShowingSearchResults(true);
            const selectedDoc = documents.find((doc) => doc.id === docId);
            const targetName = selectedDoc?.file_name ?? 'selected file';
            const modeLabel = searchMode === 'graph' ? 'graph' : 'vector';
            if (hits.length === 0) {
                setStatus(`No ${modeLabel} matches found in ${targetName}.`);
            } else {
                setStatus(`Found ${hits.length} ${modeLabel} match(es) in ${targetName}.`);
            }
        } catch (err) {
            setError(`Search failed: ${String(err)}`);
        } finally {
            setIsSearching(false);
        }
    }, [documents, loadAllChunks, query, searchMode, topThreeOnly]);

    const handleSearch = async () => {
        if (!selectedDocumentId) {
            setError('Select a file from the left to run semantic search.');
            return;
        }
        await runSearch(selectedDocumentId);
    };

    const handleDeleteDocument = async (documentId: string) => {
        setError(null);
        try {
            await knowledgeService.deleteDocument(documentId);
            setDocuments((prev) => {
                const next = prev.filter((doc) => doc.id !== documentId);
                if (selectedDocumentId === documentId) {
                    setSelectedDocumentId(next[0]?.id ?? null);
                    setQuery('');
                    setIsShowingSearchResults(false);
                    setResults([]);
                } else {
                    setResults((prevResults) => prevResults.filter((hit) => hit.document_id !== documentId));
                }
                return next;
            });
            setStatus('Document removed from knowledge base.');
        } catch (err) {
            setError(`Failed to delete document: ${String(err)}`);
        }
    };

    const handleSelectDocument = (documentId: string) => {
        setSelectedDocumentId(documentId);
        setQuery('');
        setIsShowingSearchResults(false);
        setStatus(null);
        setError(null);
        setResults([]);
    };

    return (
        <div className="flex-1 h-full overflow-hidden bg-[var(--surface-app)] text-neutral-100">
            <div className="h-full w-full max-w-6xl mx-auto px-4 md:px-6 py-5 md:py-6 flex flex-col gap-4">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-indigo-600/20 flex items-center justify-center">
                            <BookText size={20} className="text-indigo-300" />
                        </div>
                        <div>
                            <h1 className="text-xl font-semibold">Knowledge</h1>
                            <p className="text-xs text-neutral-400">
                                {documents.length} document(s), {totalChunks} vector chunk(s)
                            </p>
                        </div>
                    </div>

                    <button
                        onClick={() => void handleUpload()}
                        disabled={isUploading}
                        className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-medium transition-colors"
                    >
                        {isUploading ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                        Add File
                    </button>
                </div>

                {isUploading && activeIngestFile && (
                    <div className="flex items-center gap-2 text-xs text-neutral-300 animate-[slide-up_0.18s_ease-out]">
                        <Loader2 size={14} className="animate-spin text-indigo-300" />
                        <span className="text-neutral-200">{activeIngestStage}</span>
                        <span className="text-neutral-500">
                            ({activeIngestIndex}/{activeIngestTotal})
                        </span>
                        <span className="truncate text-neutral-400">{activeIngestFile}</span>
                    </div>
                )}

                {error && (
                    <div className="rounded-lg px-3 py-2 text-sm border bg-red-500/10 border-red-500/30 text-red-300">
                        {error}
                    </div>
                )}

                <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
                    <section className="rounded-xl border border-neutral-700 bg-neutral-900/30 overflow-hidden flex flex-col">
                        <header className="px-4 py-3 border-b border-neutral-700/70 text-sm font-medium text-neutral-300">
                            Indexed Files
                        </header>
                        <div className="flex-1 overflow-y-auto">
                            {isLoadingDocs ? (
                                <div className="p-4 text-sm text-neutral-500">Loading documents...</div>
                            ) : documents.length === 0 ? (
                                <div className="p-4 text-sm text-neutral-500">
                                    No files indexed yet. Add a file to build your knowledge base.
                                </div>
                            ) : (
                                <div className="p-2 space-y-2">
                                    {documents.map((doc) => (
                                        <div
                                            key={doc.id}
                                            onClick={() => handleSelectDocument(doc.id)}
                                            className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                                                selectedDocumentId === doc.id
                                                    ? 'border-indigo-500/70 bg-indigo-500/10'
                                                    : 'border-neutral-700/70 bg-neutral-900/60 hover:border-neutral-500/70'
                                            }`}
                                        >
                                            <div className="flex items-start gap-2">
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-sm font-medium truncate">{doc.file_name}</div>
                                                    <div className="text-xs text-neutral-500 mt-1">{doc.chunk_count} chunks</div>
                                                    <div className="text-xs text-neutral-500">{formatDate(doc.created_at)}</div>
                                                </div>
                                                <IconButton
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        void handleDeleteDocument(doc.id);
                                                    }}
                                                    icon={<Trash2 size={14} />}
                                                    ariaLabel="Delete document"
                                                    tone="danger"
                                                    size="sm"
                                                />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </section>

                    <section className="rounded-xl border border-neutral-700 bg-neutral-900/30 overflow-hidden flex flex-col">
                        <header className="px-4 py-3 border-b border-neutral-700/70 flex flex-col gap-3">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-medium text-neutral-300">
                                    {isShowingSearchResults
                                        ? (searchMode === 'graph' ? 'Graph Matches' : 'Vector Matches')
                                        : 'Document Chunks'}
                                </span>
                                <div className="inline-flex items-center gap-2">
                                    <div className="inline-flex items-center gap-2 rounded-md border border-neutral-700 px-2.5 py-1">
                                        <label className="inline-flex items-center gap-1.5 text-xs text-neutral-300">
                                            <input
                                                type="radio"
                                                name="knowledge-results-view"
                                                checked={resultsViewMode === 'normal'}
                                                onChange={() => setResultsViewMode('normal')}
                                                className="accent-indigo-500"
                                            />
                                            Normal
                                        </label>
                                        <label className="inline-flex items-center gap-1.5 text-xs text-neutral-300">
                                            <input
                                                type="radio"
                                                name="knowledge-results-view"
                                                checked={resultsViewMode === 'graph'}
                                                onChange={() => setResultsViewMode('graph')}
                                                className="accent-indigo-500"
                                            />
                                            Graph View
                                        </label>
                                    </div>
                                    <div className="inline-flex rounded-md border border-neutral-700 overflow-hidden">
                                        <button
                                            onClick={() => setSearchMode('vector')}
                                            className={`px-2.5 py-1 text-xs transition-colors ${
                                                searchMode === 'vector'
                                                    ? 'bg-indigo-500/20 text-indigo-200'
                                                    : 'bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                                            }`}
                                        >
                                            Vector
                                        </button>
                                        <button
                                            onClick={() => setSearchMode('graph')}
                                            className={`px-2.5 py-1 text-xs transition-colors border-l border-neutral-700 ${
                                                searchMode === 'graph'
                                                    ? 'bg-indigo-500/20 text-indigo-200'
                                                    : 'bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                                            }`}
                                        >
                                            Graph
                                        </button>
                                    </div>
                                    <Checkbox
                                        checked={topThreeOnly}
                                        onCheckedChange={setTopThreeOnly}
                                        label="Top 3 only"
                                        labelClassName="text-xs text-neutral-400"
                                        size="sm"
                                        ariaLabel="Top 3 only"
                                    />
                                </div>
                            </div>
                            <div className="flex gap-2">
                                <TextInput
                                    containerClassName="flex-1"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            void handleSearch();
                                        }
                                    }}
                                    placeholder={selectedDocumentId
                                        ? `Search selected file using ${searchMode}...`
                                        : 'Select a file on the left first...'}
                                    disabled={!selectedDocumentId}
                                    leftAdornment={<Search size={16} />}
                                    inputSize="md"
                                    className="bg-neutral-900"
                                    aria-label="Knowledge search"
                                />
                                <button
                                    onClick={() => void handleSearch()}
                                    disabled={isSearching || !selectedDocumentId}
                                    className="px-4 py-2.5 rounded-lg bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 text-sm font-medium transition-colors"
                                >
                                    {isSearching ? 'Searching...' : 'Search'}
                                </button>
                            </div>
                            {status && !error && (
                                <p className="text-xs text-neutral-400">
                                    {status}
                                </p>
                            )}
                        </header>
                        <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-neutral-700 p-3 space-y-3">
                            {results.length === 0 ? (
                                <div className="text-sm text-neutral-500 px-1 py-3">
                                    {selectedDocumentId
                                        ? 'No chunks to display. Try another file or run a search.'
                                        : 'Select a file on the left to view chunks.'}
                                </div>
                            ) : resultsViewMode === 'graph' ? (
                                <div className="space-y-3">
                                    {graphDiagram ? (
                                        <>
                                            <div className="rounded-lg border border-neutral-700/70 bg-neutral-900/70 px-3 py-2 text-xs text-neutral-300 flex items-center justify-between gap-3">
                                                <span>
                                                    Showing {graphDiagram.renderedNodes} node(s)
                                                    {graphDiagram.totalNodes > graphDiagram.renderedNodes
                                                        ? ` out of ${graphDiagram.totalNodes}`
                                                        : ''}
                                                    {' '}with {graphDiagram.lexicalEdgeCount} lexical edge(s).
                                                </span>
                                                <button
                                                    onClick={() => setIsGraphModalOpen(true)}
                                                    className="inline-flex items-center gap-1 rounded-md border border-neutral-600 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-700/60 transition-colors"
                                                >
                                                    <Maximize2 size={12} />
                                                    Open large
                                                </button>
                                            </div>
                                            <div className="rounded-lg border border-neutral-700/70 bg-neutral-900/40 px-3 py-2 text-xs text-neutral-500">
                                                Graph opens in modal for full-size viewing.
                                            </div>
                                        </>
                                    ) : (
                                        <div className="text-sm text-neutral-500 px-1 py-3">
                                            No graph data available for the current selection.
                                        </div>
                                    )}
                                </div>
                            ) : (
                                results.map((hit, index) => (
                                    <details key={hit.chunk_id} className="rounded-lg border border-neutral-700/70 bg-neutral-900/70 px-3 py-2">
                                        <summary className="cursor-pointer list-none">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="text-xs text-indigo-300 font-medium truncate">{hit.file_name}</div>
                                                    <div className="mt-1 text-sm text-neutral-200 break-words">{previewText(hit.content)}</div>
                                                </div>
                                                <div className="text-[11px] text-neutral-400 whitespace-nowrap">
                                                    {isShowingSearchResults
                                                        ? `#${index + 1} · score ${hit.score.toFixed(3)}`
                                                        : `Chunk ${index + 1}`}
                                                </div>
                                            </div>
                                        </summary>
                                        <p className="mt-3 text-sm text-neutral-200 whitespace-pre-wrap break-words border-t border-neutral-700/70 pt-3 max-h-72 overflow-y-auto scrollbar-thin scrollbar-thumb-neutral-700 pr-1">
                                            {hit.content}
                                        </p>
                                    </details>
                                ))
                            )}
                        </div>
                    </section>
                </div>
            </div>

            {isGraphModalOpen && graphDiagram && (
                <div
                    className="fixed inset-0 z-[140] bg-black/75 p-3 md:p-6"
                    onClick={() => setIsGraphModalOpen(false)}
                >
                    <div
                        className="mx-auto h-full w-full max-w-[min(96vw,1400px)] overflow-hidden rounded-xl border border-neutral-700 bg-[var(--surface-panel)] shadow-2xl flex flex-col"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className="flex items-center justify-between gap-3 border-b border-neutral-700 px-4 py-3">
                            <div className="min-w-0">
                                <div className="text-sm font-semibold text-neutral-100">Knowledge Graph</div>
                                <div className="text-xs text-neutral-400">
                                    {graphDiagram.renderedNodes} node(s)
                                    {graphDiagram.totalNodes > graphDiagram.renderedNodes
                                        ? ` of ${graphDiagram.totalNodes}`
                                        : ''}
                                    {' '}· {graphDiagram.lexicalEdgeCount} lexical edge(s)
                                </div>
                            </div>
                            <IconButton
                                onClick={() => setIsGraphModalOpen(false)}
                                icon={<X size={16} />}
                                ariaLabel="Close graph modal"
                                size="sm"
                            />
                        </div>

                        <div className="min-h-0 flex-1 overflow-auto p-3 md:p-5">
                            <MermaidBlock
                                value={graphDiagram.mermaid}
                                className="m-0"
                                bodyClassName="min-h-[72vh] md:min-h-[76vh] items-start [&_svg]:max-w-none"
                            />
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
