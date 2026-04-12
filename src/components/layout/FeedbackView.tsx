import { useEffect, useState, useCallback } from 'react';
import { ThumbsUp, ThumbsDown, Filter, RefreshCw, MessageSquare, Download } from 'lucide-react';
import { feedbackService } from '../../services/feedbackService';
import type { Feedback, FeedbackRating } from '../../types';
import { Dropdown } from '../ui/Dropdown';
import { IconButton } from '../ui/IconButton';

type FilterMode = 'all' | 'good' | 'bad';
type ExportFormat = 'jsonl' | 'json' | 'csv';

export function FeedbackView() {
    const [feedbacks, setFeedbacks] = useState<Feedback[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [filter, setFilter] = useState<FilterMode>('all');
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [actionStatus, setActionStatus] = useState<string | null>(null);
    const [exportFormat, setExportFormat] = useState<ExportFormat>('jsonl');

    const loadFeedback = useCallback(async (mode: FilterMode) => {
        setIsLoading(true);
        try {
            const ratingFilter: FeedbackRating | undefined =
                mode === 'all' ? undefined : mode;
            const items = await feedbackService.listAllFeedback(ratingFilter);
            setFeedbacks(items);
        } catch (err) {
            console.error('Failed to load feedback:', err);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        loadFeedback(filter);
    }, [filter, loadFeedback]);

    const handleRefresh = () => {
        loadFeedback(filter);
    };

    const exportRecords = useCallback((items: Feedback[]) => items.map((fb) => ({
        messages: [
            { role: 'user' as const, content: fb.prompt },
            { role: 'assistant' as const, content: fb.response },
        ],
        metadata: {
            feedback_id: fb.id,
            message_id: fb.message_id,
            rating: fb.rating,
            created_at: fb.created_at,
            source: 'feedback_history',
        },
    })), []);

    const downloadText = useCallback((filename: string, content: string, mime: string) => {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        URL.revokeObjectURL(url);
    }, []);

    const handleExportJsonl = useCallback(() => {
        if (feedbacks.length === 0) {
            setActionStatus('No feedback entries to export.');
            return;
        }
        const payload = exportRecords(feedbacks)
            .map((record) => JSON.stringify(record))
            .join('\n');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadText(`feedback-openai-${timestamp}.jsonl`, payload, 'application/x-ndjson');
        setActionStatus(`Exported ${feedbacks.length} record(s) as OpenAI JSONL.`);
    }, [downloadText, exportRecords, feedbacks]);

    const handleExportJson = useCallback(() => {
        if (feedbacks.length === 0) {
            setActionStatus('No feedback entries to export.');
            return;
        }
        const payload = JSON.stringify(exportRecords(feedbacks), null, 2);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadText(`feedback-openai-${timestamp}.json`, payload, 'application/json');
        setActionStatus(`Exported ${feedbacks.length} record(s) as OpenAI JSON.`);
    }, [downloadText, exportRecords, feedbacks]);

    const escapeCsvValue = useCallback((value: string) => `"${value.replace(/"/g, '""')}"`, []);

    const handleExportCsv = useCallback(() => {
        if (feedbacks.length === 0) {
            setActionStatus('No feedback entries to export.');
            return;
        }

        const header = [
            'prompt',
            'response',
            'rating',
            'message_id',
            'feedback_id',
            'created_at',
            'source',
        ].join(',');

        const rows = feedbacks.map((fb) => [
            escapeCsvValue(fb.prompt),
            escapeCsvValue(fb.response),
            escapeCsvValue(fb.rating),
            escapeCsvValue(fb.message_id),
            escapeCsvValue(fb.id),
            escapeCsvValue(fb.created_at),
            escapeCsvValue('feedback_history'),
        ].join(','));

        const payload = [header, ...rows].join('\n');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadText(`feedback-openai-${timestamp}.csv`, payload, 'text/csv;charset=utf-8');
        setActionStatus(`Exported ${feedbacks.length} record(s) as CSV.`);
    }, [downloadText, escapeCsvValue, feedbacks]);

    const handleExportByFormat = useCallback((format: ExportFormat) => {
        setExportFormat(format);
        if (format === 'jsonl') {
            handleExportJsonl();
            return;
        }
        if (format === 'json') {
            handleExportJson();
            return;
        }
        handleExportCsv();
    }, [handleExportCsv, handleExportJson, handleExportJsonl]);

    const toggleExpand = (id: string) => {
        setExpandedId(prev => (prev === id ? null : id));
    };

    return (
        <div className="flex-1 flex flex-col h-full bg-[var(--surface-app)] overflow-hidden">
            {/* Header */}
            <div className="shrink-0 px-4 md:px-6 pt-5 md:pt-6 pb-4 border-b border-neutral-700/50">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-indigo-600/20 flex items-center justify-center">
                            <MessageSquare size={18} className="text-indigo-400" />
                        </div>
                        <div>
                            <h1 className="text-lg font-semibold text-white">Feedback History</h1>
                            <p className="text-xs text-neutral-500">
                                {feedbacks.length} {feedbacks.length === 1 ? 'entry' : 'entries'}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Dropdown
                            options={[
                                {
                                    id: 'export-jsonl',
                                    value: 'jsonl',
                                    label: 'Export JSONL',
                                    icon: <Download size={12} className="text-neutral-300" />,
                                },
                                {
                                    id: 'export-json',
                                    value: 'json',
                                    label: 'Export JSON',
                                    icon: <Download size={12} className="text-neutral-300" />,
                                },
                                {
                                    id: 'export-csv',
                                    value: 'csv',
                                    label: 'Export CSV',
                                    icon: <Download size={12} className="text-neutral-300" />,
                                },
                            ]}
                            value={exportFormat}
                            onChange={(value) => handleExportByFormat(value as ExportFormat)}
                            placeholder="Export"
                            className="w-36"
                        />
                        <IconButton
                            onClick={handleRefresh}
                            icon={<RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />}
                            ariaLabel="Refresh"
                            size="md"
                            className="hover:bg-neutral-700/60"
                        />
                    </div>
                </div>

                {/* Filter tabs */}
                <div className="flex gap-1 p-1 bg-neutral-800 rounded-lg w-fit">
                    {([
                        { key: 'all', label: 'All', icon: Filter },
                        { key: 'good', label: 'Good', icon: ThumbsUp },
                        { key: 'bad', label: 'Bad', icon: ThumbsDown },
                    ] as const).map(({ key, label, icon: Icon }) => (
                        <button
                            key={key}
                            onClick={() => setFilter(key)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                                filter === key
                                    ? 'bg-neutral-700 text-white shadow-sm'
                                    : 'text-neutral-400 hover:text-neutral-200'
                            }`}
                        >
                            <Icon size={12} />
                            {label}
                        </button>
                    ))}
                </div>
                {actionStatus && (
                    <p className="text-xs text-neutral-500 mt-3">{actionStatus}</p>
                )}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-neutral-700 px-4 md:px-6 py-5">
                {isLoading ? (
                    <div className="flex items-center justify-center py-20">
                        <RefreshCw size={20} className="animate-spin text-neutral-500" />
                    </div>
                ) : feedbacks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 text-neutral-500">
                        <MessageSquare size={40} className="mb-3 opacity-40" />
                        <p className="text-sm">No feedback recorded yet.</p>
                        <p className="text-xs mt-1">Rate responses in chat to see them here.</p>
                    </div>
                ) : (
                    <div className="space-y-3 max-w-3xl mx-auto">
                        {feedbacks.map((fb) => (
                            <FeedbackCard
                                key={fb.id}
                                feedback={fb}
                                isExpanded={expandedId === fb.id}
                                onToggle={() => toggleExpand(fb.id)}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

interface FeedbackCardProps {
    feedback: Feedback;
    isExpanded: boolean;
    onToggle: () => void;
}

function FeedbackCard({ feedback, isExpanded, onToggle }: FeedbackCardProps) {
    const isGood = feedback.rating === 'good';
    const ratingColor = isGood ? 'text-emerald-400' : 'text-red-400';
    const ratingBg = isGood ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20';
    const RatingIcon = isGood ? ThumbsUp : ThumbsDown;

    const formattedDate = (() => {
        try {
            return new Date(feedback.created_at).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
            });
        } catch {
            return feedback.created_at;
        }
    })();

    return (
        <div
            className={`rounded-xl border transition-all cursor-pointer hover:border-neutral-600 ${ratingBg}`}
            onClick={onToggle}
        >
            <div className="flex items-start gap-3 p-4">
                <div className={`shrink-0 mt-0.5 ${ratingColor}`}>
                    <RatingIcon size={16} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                        <span className={`text-xs font-medium uppercase tracking-wider ${ratingColor}`}>
                            {feedback.rating}
                        </span>
                        <span className="text-xs text-neutral-500 shrink-0">{formattedDate}</span>
                    </div>
                    <p className="text-sm text-neutral-300 line-clamp-2">
                        <span className="text-neutral-500 font-medium">Prompt: </span>
                        {feedback.prompt}
                    </p>
                    {!isExpanded && (
                        <p className="text-sm text-neutral-400 mt-1 line-clamp-1">
                            <span className="text-neutral-500 font-medium">Response: </span>
                            {feedback.response}
                        </p>
                    )}
                </div>
            </div>

            {isExpanded && (
                <div className="px-4 pb-4 pt-0 space-y-3 border-t border-neutral-700/30 mt-0">
                    <div className="pt-3">
                        <div className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-1.5">
                            Prompt
                        </div>
                        <div className="text-sm text-neutral-200 bg-neutral-900/50 rounded-lg p-3 whitespace-pre-wrap break-words">
                            {feedback.prompt}
                        </div>
                    </div>
                    <div>
                        <div className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-1.5">
                            Response
                        </div>
                        <div className="text-sm text-neutral-200 bg-neutral-900/50 rounded-lg p-3 whitespace-pre-wrap break-words max-h-80 overflow-y-auto scrollbar-thin scrollbar-thumb-neutral-700">
                            {feedback.response}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
