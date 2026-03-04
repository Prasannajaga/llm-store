import { useEffect, useRef } from 'react';

export function useAutoScroll(dependency: any) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (containerRef.current) {
            const scrollElement = containerRef.current;
            scrollElement.scrollTop = scrollElement.scrollHeight;
        }
    }, [dependency]);

    return containerRef;
}
