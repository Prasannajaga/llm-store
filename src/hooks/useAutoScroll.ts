import { useEffect, useRef } from 'react';

export function useAutoScroll(dependency: unknown) {
    const containerRef = useRef<HTMLDivElement>(null);
    const isUserScrolledUp = useRef(false);
    const pendingRaf = useRef<number | null>(null);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const handleScroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = container;
            const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
            isUserScrolledUp.current = !isAtBottom;
        };

        container.addEventListener('scroll', handleScroll, { passive: true });
        return () => {
            container.removeEventListener('scroll', handleScroll);
            if (pendingRaf.current !== null) {
                cancelAnimationFrame(pendingRaf.current);
                pendingRaf.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (containerRef.current && !isUserScrolledUp.current) {
            if (pendingRaf.current !== null) {
                cancelAnimationFrame(pendingRaf.current);
            }
            pendingRaf.current = requestAnimationFrame(() => {
                if (containerRef.current) {
                    containerRef.current.scrollTop = containerRef.current.scrollHeight;
                }
                pendingRaf.current = null;
            });
        }
    }, [dependency]);

    return containerRef;
}
