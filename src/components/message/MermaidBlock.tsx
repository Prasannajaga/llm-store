import { useEffect, useRef, useState, memo } from 'react';
import { Copy, Check, AlertTriangle } from 'lucide-react';

interface MermaidBlockProps {
    value: string;
    className?: string;
    bodyClassName?: string;
}

let mermaidInitialized = false;

export const MermaidBlock = memo(function MermaidBlock({
    value,
    className = '',
    bodyClassName = '',
}: MermaidBlockProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [svg, setSvg] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        let cancelled = false;

        async function renderDiagram() {
            try {
                const mermaid = (await import('mermaid')).default;

                if (!mermaidInitialized) {
                    mermaid.initialize({
                        startOnLoad: false,
                        theme: 'dark',
                        themeVariables: {
                            darkMode: true,
                            background: '#0d1117',
                            primaryColor: '#6366f1',
                            primaryTextColor: '#e5e5e5',
                            primaryBorderColor: '#4f46e5',
                            lineColor: '#525252',
                            secondaryColor: '#1e1e2e',
                            tertiaryColor: '#161b22',
                            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
                        },
                        securityLevel: 'strict',
                        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
                    });
                    mermaidInitialized = true;
                }

                const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const { svg: renderedSvg } = await mermaid.render(id, value.trim());

                if (!cancelled) {
                    setSvg(renderedSvg);
                    setError(null);
                }
            } catch (err) {
                if (!cancelled) {
                    setError(String(err));
                    setSvg(null);
                }
            }
        }

        renderDiagram();
        return () => { cancelled = true; };
    }, [value]);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    if (error) {
        return (
            <div className="my-4 rounded-lg border border-amber-500/20 bg-amber-500/5 overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20">
                    <AlertTriangle size={14} className="text-amber-400" />
                    <span className="text-xs text-amber-400 font-medium">Diagram render failed</span>
                </div>
                <pre className="p-4 text-xs text-neutral-400 font-mono overflow-x-auto whitespace-pre-wrap">
                    {value}
                </pre>
            </div>
        );
    }

    if (!svg) {
        return (
            <div className="my-4 flex items-center justify-center h-32 rounded-lg bg-[var(--surface-diagram)] border border-neutral-800/60">
                <div className="flex items-center gap-2 text-neutral-500 text-sm">
                    <div className="w-4 h-4 border-2 border-neutral-600 border-t-indigo-500 rounded-full animate-spin" />
                    Rendering diagram…
                </div>
            </div>
        );
    }

    return (
        <div className={`mermaid-block my-4 rounded-lg bg-[var(--surface-diagram)] border border-neutral-800/60 overflow-hidden ${className}`}>
            <div className="flex items-center justify-between px-4 py-2 bg-[var(--surface-diagram-header)] border-b border-neutral-800/60">
                <span className="text-xs text-neutral-400 font-mono select-none">mermaid</span>
                <button
                    onClick={handleCopy}
                    className="text-neutral-400 hover:text-neutral-200 transition-colors flex items-center gap-1.5 text-xs"
                >
                    {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                    <span>{copied ? 'Copied!' : 'Copy'}</span>
                </button>
            </div>
            <div
                ref={containerRef}
                className={`p-6 flex items-center justify-center overflow-x-auto [&_svg]:max-w-full ${bodyClassName}`}
                dangerouslySetInnerHTML={{ __html: svg }}
            />
        </div>
    );
});
