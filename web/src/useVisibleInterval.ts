import { useEffect, useRef } from 'react'

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

export function mergeFirstPage<T extends { messageId: string }>(
    current: T[],
    incoming: T[]
): { items: T[]; keptTail: boolean } {
    const incomingIds = new Set(incoming.map((item) => item.messageId))
    const tail = current.filter((item) => !incomingIds.has(item.messageId))
    return { items: [...incoming, ...tail], keptTail: tail.length > 0 }
}
