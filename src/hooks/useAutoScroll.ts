import { useEffect, useRef } from 'react';

export function useAutoScroll(dependency: unknown) {
    const containerRef = useRef<HTMLDivElement>(null);
    const isUserScrolledUp = useRef(false);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const handleScroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = container;
            const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
            isUserScrolledUp.current = !isAtBottom;
        };

        container.addEventListener('scroll', handleScroll, { passive: true });
        return () => container.removeEventListener('scroll', handleScroll);
    }, []);

    useEffect(() => {
        if (containerRef.current && !isUserScrolledUp.current) {
            requestAnimationFrame(() => {
                if (containerRef.current) {
                    containerRef.current.scrollTop = containerRef.current.scrollHeight;
                }
            });
        }
    }, [dependency]);

    return containerRef;
}
