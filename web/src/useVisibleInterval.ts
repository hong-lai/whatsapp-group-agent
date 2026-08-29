import { useEffect, useLayoutEffect, useRef, type RefObject, type UIEvent } from 'react'

export type SortOrder = 'asc' | 'desc'

const PIN_THRESHOLD = 80

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
    enabled: boolean,
    resetKey?: string
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
    }, [enabled, resetKey, rootRef])

    return sentinelRef
}

export function usePinnedScroll(
    listRef: RefObject<HTMLElement | null>,
    items: unknown[],
    sortOrder: SortOrder,
    resetKey: string,
    scrollRestore: RefObject<{ top: number; height: number } | null>
) {
    const stickToBottom = useRef(sortOrder === 'asc')
    const didInitialScroll = useRef(false)

    useLayoutEffect(() => {
        didInitialScroll.current = false
        stickToBottom.current = sortOrder === 'asc'
        scrollRestore.current = null
    }, [resetKey, sortOrder, scrollRestore])

    useLayoutEffect(() => {
        const list = listRef.current
        if (!list) return
        const pending = scrollRestore.current
        if (pending) {
            list.scrollTop = pending.top + (list.scrollHeight - pending.height)
            scrollRestore.current = null
            return
        }
        if (sortOrder === 'asc' && (stickToBottom.current || !didInitialScroll.current)) {
            list.scrollTop = list.scrollHeight
            didInitialScroll.current = true
            return
        }
        if (sortOrder === 'desc' && !didInitialScroll.current) {
            list.scrollTop = 0
            didInitialScroll.current = true
        }
    }, [items, listRef, scrollRestore, sortOrder])

    function onScroll(_event?: UIEvent<HTMLElement>) {
        const list = listRef.current
        if (!list || sortOrder !== 'asc') return
        stickToBottom.current =
            list.scrollHeight - list.scrollTop - list.clientHeight <= PIN_THRESHOLD
    }

    return { onScroll }
}

export function mergeFirstPage<T extends { messageId: string }>(
    current: T[],
    incoming: T[]
): { items: T[]; keptTail: boolean } {
    const incomingIds = new Set(incoming.map((item) => item.messageId))
    const tail = current.filter((item) => !incomingIds.has(item.messageId))
    return { items: [...incoming, ...tail], keptTail: tail.length > 0 }
}
