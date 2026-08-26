import { useEffect, useRef, type RefObject } from 'react'

export function useVisibleInterval(callback: () => void, ms: number | null) {
    const saved = useRef(callback)
    saved.current = callback

    useEffect(() => {
        if (ms == null) return undefined

        let timer: ReturnType<typeof setInterval> | undefined

        const stop = () => {
            if (timer !== undefined) {
                clearInterval(timer)
                timer = undefined
            }
        }

        const tick = () => {
            if (document.visibilityState === 'visible') saved.current()
        }

        const start = () => {
            stop()
            timer = setInterval(tick, ms)
        }

        const onVisibility = () => {
            if (document.visibilityState === 'hidden') {
                stop()
                return
            }
            tick()
            start()
        }

        if (document.visibilityState === 'visible') start()
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
            stop()
            document.removeEventListener('visibilitychange', onVisibility)
        }
    }, [ms])
}

export function useInfiniteScroll(
    rootRef: RefObject<Element | null>,
    onLoadMore: () => void,
    enabled: boolean
): RefObject<HTMLDivElement | null> {
    const onLoadMoreRef = useRef(onLoadMore)
    onLoadMoreRef.current = onLoadMore
    const sentinelRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const root = rootRef.current
        const sentinel = sentinelRef.current
        if (!enabled || !root || !sentinel) return undefined
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) onLoadMoreRef.current()
            },
            { root, rootMargin: '160px' }
        )
        observer.observe(sentinel)
        return () => observer.disconnect()
    }, [enabled, rootRef])

    return sentinelRef
}

export function mergeFirstPage<T extends { messageId: string }>(
    current: T[],
    incoming: T[]
): { items: T[]; keptTail: boolean } {
    const incomingIds = new Set(incoming.map((item) => item.messageId))
    const tail = current.filter((item) => !incomingIds.has(item.messageId))
    return { items: [...incoming, ...tail], keptTail: tail.length > 0 }
}
