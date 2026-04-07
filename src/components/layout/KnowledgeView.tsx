import { useCallback, useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { BookText, Loader2, Plus, Search, Trash2 } from 'lucide-react';
import { knowledgeService } from '../../services/knowledgeService';
import type { KnowledgeDocument, KnowledgeSearchResult } from '../../types';

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

export function KnowledgeView() {
    const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
    const [results, setResults] = useState<KnowledgeSearchResult[]>([]);
    const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [topThreeOnly, setTopThreeOnly] = useState(true);
    const [searchMode, setSearchMode] = useState<'vector' | 'graph'>('vector');
    const [isLoadingDocs, setIsLoadingDocs] = useState(true);
    const [isUploading, setIsUploading] = useState(false);
    const [isSearching, setIsSearching] = useState(false);
    const [isShowingSearchResults, setIsShowingSearchResults] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const totalChunks = useMemo(
        () => documents.reduce((sum, doc) => sum + doc.chunk_count, 0),
        [documents],
    );

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
            let ingestedChunks = 0;
            for (const path of paths) {
                const result = await knowledgeService.ingestFile(path);
                ingestedChunks += result.chunks;
            }
            await loadDocuments();
            setStatus(`Indexed ${paths.length} file(s) into ${ingestedChunks} vector chunks.`);
        } catch (err) {
            setError(`Failed to ingest file(s): ${String(err)}`);
        } finally {
            setIsUploading(false);
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
        <div className="flex-1 h-full overflow-hidden bg-[#212121] text-neutral-100">
            <div className="h-full max-w-6xl mx-auto px-4 md:px-6 py-6 flex flex-col gap-4">
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
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        void handleDeleteDocument(doc.id);
                                                    }}
                                                    className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 hover:text-red-300 transition-colors"
                                                    title="Delete document"
                                                >
                                                    <Trash2 size={14} />
                                                </button>
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
                                    <label className="inline-flex items-center gap-2 text-xs text-neutral-400">
                                        <input
                                            type="checkbox"
                                            checked={topThreeOnly}
                                            onChange={(e) => setTopThreeOnly(e.target.checked)}
                                            className="accent-indigo-500"
                                        />
                                        Top 3 only
                                    </label>
                                </div>
                            </div>
                            <div className="flex gap-2">
                                <div className="relative flex-1">
                                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
                                    <input
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
                                        className="w-full bg-neutral-900 border border-neutral-700 rounded-lg py-2.5 pl-9 pr-3 text-sm focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                                    />
                                </div>
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
                        <div className="flex-1 overflow-y-auto p-3 space-y-3">
                            {results.length === 0 ? (
                                <div className="text-sm text-neutral-500 px-1 py-3">
                                    {selectedDocumentId
                                        ? 'No chunks to display. Try another file or run a search.'
                                        : 'Select a file on the left to view chunks.'}
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
                                        <p className="mt-3 text-sm text-neutral-200 whitespace-pre-wrap break-words border-t border-neutral-700/70 pt-3">
                                            {hit.content}
                                        </p>
                                    </details>
                                ))
                            )}
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
}
