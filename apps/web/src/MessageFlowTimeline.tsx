import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { useVisibleInterval } from './useVisibleInterval'

type IntervalMinutes = 1 | 5 | 10 | 30 | 60

type FlowPoint = {
    start: string
    count: number
    reportCount: number
}

type MessageFlow = {
    intervalMinutes: IntervalMinutes
    points: FlowPoint[]
    peakStart: string | null
    peakCount: number
    total: number
    reportTotal: number
    error?: string
}

type Particle = {
    slot: number
    dx: number
    y: number
    vy: number
    r: number
    life: number
    decay: number
    kind: 'bubble' | 'spark'
}

type HitBox = { x: number; y: number; w: number; h: number }

type PlaceMode = 'reset' | 'keep' | 'anchor'

type Playback = {
    points: FlowPoint[]
    peakIndex: number
    peakCount: number
    viewStart: number
    playhead: number
    reduced: boolean
    interval: IntervalMinutes
    width: number
    height: number
    multiDay: boolean
    particles: Particle[]
    ambient: number
    compact: boolean
    live: boolean
    messageHead: number | null
    lastLiveSlot: number
    lastLiveCount: number
    hitLeft: HitBox | null
    hitRight: HitBox | null
}

const INTERVALS: { minutes: IntervalMinutes; label: string }[] = [
    { minutes: 1, label: '1m' },
    { minutes: 5, label: '5m' },
    { minutes: 10, label: '10m' },
    { minutes: 30, label: '30m' },
    { minutes: 60, label: '1h' },
]

const NOW_COLOR = '#3d6df2'
const PLOT_TOP = 26
const AXIS_INSET = 22
const STORAGE_KEY = 'message-flow-interval'
const VISIBLE_KEY = 'messageFlowOpen'
const LIVE_KEY = 'messageFlowLive'

function readFlowLive(): boolean {
    try {
        return localStorage.getItem(LIVE_KEY) === '1'
    } catch {
        return false
    }
}

function readFlowVisible(): boolean {
    try {
        return localStorage.getItem(VISIBLE_KEY) === '1'
    } catch {
        return false
    }
}

function readInterval(): IntervalMinutes {
    try {
        const stored = sessionStorage.getItem(STORAGE_KEY)
        if (stored === '1' || stored === '5' || stored === '10' || stored === '30' || stored === '60') {
            return Number(stored) as IntervalMinutes
        }
    } catch {
        // The default still applies for this visit.
    }
    return 60
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
}

function isAbort(reason: unknown): boolean {
    return reason instanceof Error && reason.name === 'AbortError'
}

function isMultiDay(points: FlowPoint[]): boolean {
    if (points.length < 2) return false
    return points[0].start.slice(0, 10) !== points[points.length - 1].start.slice(0, 10)
}

function formatSlot(start: string, withDate: boolean): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(start)
    if (!match) return start
    const time = `${match[4]}:${match[5]}`
    if (!withDate) return time
    return `${match[2]}/${match[3]} ${time}`
}

function countLabel(count: number, singular: string, plural: string): string {
    return `${count} ${count === 1 ? singular : plural}`
}

function readoutFor(point: FlowPoint, multiDay: boolean): string {
    const parts = [formatSlot(point.start, multiDay), countLabel(point.count, 'message', 'messages')]
    if (point.reportCount > 0) {
        parts.push(countLabel(point.reportCount, 'site report', 'site reports'))
    }
    return parts.join(' · ')
}

function nearestIndex(points: FlowPoint[], anchor: string): number {
    let index = 0
    for (let i = 0; i < points.length; i += 1) {
        if (points[i].start <= anchor) index = i
        else break
    }
    return index
}

function visibleCapacity(width: number, interval: IntervalMinutes): number {
    const minSlot = interval >= 60 ? 22 : interval >= 30 ? 12 : interval >= 10 ? 7 : interval >= 5 ? 6 : 4
    return Math.max(8, Math.floor((width > 0 ? width : 320) / minSlot))
}

function metrics(playback: Playback): { visible: number; slotW: number; maxStart: number } {
    const capacity = visibleCapacity(playback.width, playback.interval)
    const visible = Math.min(capacity, Math.max(playback.points.length, 1))
    return {
        visible,
        slotW: playback.width > 0 ? playback.width / visible : 16,
        maxStart: Math.max(0, playback.points.length - visible),
    }
}

function plotBottom(height: number): number {
    return height - AXIS_INSET
}

function barHeight(
    count: number,
    peak: number,
    height: number,
    plotTop = PLOT_TOP,
    axisInset = AXIS_INSET
): number {
    if (count <= 0 || peak <= 0) return 0
    const plotH = height - axisInset - plotTop
    if (plotH <= 2) return 0
    const pad = plotH < 24 ? 1 : 8
    return Math.max(plotH < 24 ? 1.5 : 3, (count / peak) * (plotH - pad))
}

function currentSlotStart(nowMs: number, interval: IntervalMinutes): string {
    const date = new Date(nowMs + 8 * 60 * 60 * 1000)
    const pad = (value: number) => String(value).padStart(2, '0')
    const minute = Math.floor(date.getUTCMinutes() / interval) * interval
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(minute)}`
}

function playheadAt(points: FlowPoint[], interval: IntervalMinutes, ms: number): number | null {
    if (points.length === 0) return null
    const date = new Date(ms + 8 * 60 * 60 * 1000)
    const pad = (value: number) => String(value).padStart(2, '0')
    const minute = Math.floor(date.getUTCMinutes() / interval) * interval
    const slot = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(minute)}`
    const into = (date.getUTCMinutes() % interval) + date.getUTCSeconds() / 60
    const index = nearestIndex(points, slot)
    const point = points[index]
    if (!point) return null
    if (point.start === slot) return index + clamp(into / interval, 0, 0.999)
    if (slot < point.start) return index
    return Math.min(points.length - 0.001, index + 0.999)
}

function currentPlayhead(points: FlowPoint[], interval: IntervalMinutes, nowMs = Date.now()): number | null {
    if (points.length === 0) return null
    const slot = currentSlotStart(nowMs, interval)
    const index = nearestIndex(points, slot)
    const point = points[index]
    if (!point || point.start !== slot) return null
    const date = new Date(nowMs + 8 * 60 * 60 * 1000)
    const into = (date.getUTCMinutes() % interval) + date.getUTCSeconds() / 60
    return index + clamp(into / interval, 0, 0.999)
}

function nowPlayhead(points: FlowPoint[], interval: IntervalMinutes, nowMs = Date.now()): number {
    const head = currentPlayhead(points, interval, nowMs)
    if (head != null) return head
    if (points.length === 0) return 0
    const slot = currentSlotStart(nowMs, interval)
    if (slot < (points[0]?.start ?? '')) return 0
    return points.length - 1
}

/** Keep the playhead on the current Hong Kong time, and the window just behind it. */
function pinToNow(playback: Playback, nowMs = Date.now()): void {
    const head = nowPlayhead(playback.points, playback.interval, nowMs)
    const slot = Math.floor(head)
    const count = playback.points[slot]?.count ?? 0
    if (playback.lastLiveSlot === slot && count > playback.lastLiveCount && !playback.reduced) {
        spawnBurst(playback, slot)
    }
    playback.lastLiveSlot = slot
    playback.lastLiveCount = count
    playback.playhead = head
    const { visible, maxStart } = metrics(playback)
    playback.viewStart = clamp(head - visible * 0.78, 0, maxStart)
}

function applyPlacement(playback: Playback, mode: PlaceMode, anchor: string | null): void {
    const length = playback.points.length
    if (length === 0) return
    const { visible, maxStart } = metrics(playback)
    if (mode === 'keep') {
        playback.playhead = clamp(playback.playhead, 0, length - 1)
        playback.viewStart = clamp(playback.viewStart, 0, maxStart)
    } else {
        playback.particles = []
        if (mode === 'anchor' && anchor) {
            const index = nearestIndex(playback.points, anchor)
            playback.playhead = index
            playback.viewStart = clamp(index - visible * 0.5, 0, maxStart)
        } else {
            const peak = playback.peakIndex >= 0 ? playback.peakIndex : 0
            const start = clamp(peak - visible * 0.72, 0, maxStart)
            playback.viewStart = start
            playback.playhead = start
        }
    }
    if (playback.live) pinToNow(playback)
}

function spawn(playback: Playback, slot: number, kind: Particle['kind']): void {
    if (playback.particles.length > 120) playback.particles.shift()
    const point = playback.points[slot]
    if (!point) return
    const base = plotBottom(playback.height) - barHeight(point.count, playback.peakCount, playback.height)
    playback.particles.push({
        slot,
        dx: (Math.random() - 0.5) * 10,
        y: base,
        vy: kind === 'spark' ? -(26 + Math.random() * 22) : -(16 + Math.random() * 30),
        r: kind === 'spark' ? 2.4 : 1.3 + Math.random() * 1.8,
        life: 1,
        decay: 0.45 + Math.random() * 0.35,
        kind,
    })
}

function spawnBurst(playback: Playback, slot: number): void {
    const point = playback.points[slot]
    if (!point || point.count <= 0) return
    const bubbles = 1 + Math.round((point.count / (playback.peakCount || 1)) * 6)
    for (let i = 0; i < bubbles; i += 1) spawn(playback, slot, 'bubble')
    if (point.reportCount > 0) {
        const sparks = Math.min(3, point.reportCount)
        for (let i = 0; i < sparks; i += 1) spawn(playback, slot, 'spark')
    }
}

function spawnAmbient(playback: Playback): void {
    if (playback.live) {
        const slot = Math.floor(playback.playhead)
        const point = playback.points[slot]
        if (point && point.count > 0 && Math.random() < 0.7) {
            spawn(playback, slot, 'bubble')
            if (point.reportCount > 0 && Math.random() < 0.4) spawn(playback, slot, 'spark')
            return
        }
    }
    const { visible } = metrics(playback)
    const start = Math.max(0, Math.floor(playback.viewStart))
    const end = Math.min(playback.points.length, Math.ceil(playback.viewStart + visible))
    let weight = 0
    for (let index = start; index < end; index += 1) weight += playback.points[index].count
    if (weight <= 0) return
    let pick = Math.random() * weight
    for (let index = start; index < end; index += 1) {
        pick -= playback.points[index].count
        if (pick <= 0) {
            spawn(playback, index, 'bubble')
            if (playback.points[index].reportCount > 0 && Math.random() < 0.4) {
                spawn(playback, index, 'spark')
            }
            return
        }
    }
}

function step(playback: Playback, dt: number): void {
    if (playback.points.length === 0) return
    if (!playback.reduced) {
        playback.ambient += dt
        if (playback.ambient > 0.16) {
            playback.ambient = 0
            spawnAmbient(playback)
        }
    }
    for (const particle of playback.particles) {
        particle.y += particle.vy * dt
        particle.life -= particle.decay * dt
    }
    if (playback.particles.length > 0) {
        playback.particles = playback.particles.filter((particle) => particle.life > 0 && particle.y > 4)
    }
}

function roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
): void {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    ctx.beginPath()
    ctx.moveTo(x, y - r)
    ctx.lineTo(x + r, y)
    ctx.lineTo(x, y + r)
    ctx.lineTo(x - r, y)
    ctx.closePath()
}

function drawEdgeMarker(
    ctx: CanvasRenderingContext2D,
    side: 'left' | 'right',
    width: number
): HitBox {
    const w = 58
    const h = 22
    const x = side === 'left' ? 8 : width - w - 8
    const y = 6
    ctx.fillStyle = 'rgba(248, 234, 211, 0.96)'
    roundRect(ctx, x, y, w, h, 11)
    ctx.fill()
    ctx.fillStyle = '#8a4e12'
    ctx.font = '700 11px "Noto Sans TC", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(side === 'left' ? '‹ Peak' : 'Peak ›', x + w / 2, y + h / 2 + 0.5)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    return { x, y, w, h }
}

function drawScene(ctx: CanvasRenderingContext2D, playback: Playback, now: number): void {
    const { width, height, points } = playback
    playback.hitLeft = null
    playback.hitRight = null
    if (width <= 0 || height <= 0 || points.length === 0) return
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'

    const compact = playback.compact
    const plotTop = compact ? 3 : PLOT_TOP
    const axisInset = compact ? 3 : AXIS_INSET
    const { visible, slotW } = metrics(playback)
    const viewStart = playback.viewStart
    const bottom = height - axisInset
    const peak = playback.peakCount || 1
    const pulse = playback.reduced ? 1 : 0.55 + 0.45 * Math.sin(now / 280)
    const start = Math.max(0, Math.floor(viewStart))
    const end = Math.min(points.length, Math.ceil(viewStart + visible) + 1)

    ctx.fillStyle = 'rgba(14, 102, 85, 0.18)'
    ctx.fillRect(0, bottom, width, 1)

    const fill = ctx.createLinearGradient(0, plotTop, 0, bottom)
    fill.addColorStop(0, '#7ddec0')
    fill.addColorStop(1, '#0f7664')

    for (let index = start; index < end; index += 1) {
        const point = points[index]
        if (!point) continue
        const count = point.count
        const reportCount = point.reportCount
        const isPeak = index === playback.peakIndex && count > 0
        const x = (index - viewStart) * slotW
        const heightPx = barHeight(count, peak, height, plotTop, axisInset)
        const barW = Math.max(1, slotW - (compact ? 0.5 : 2))
        const bx = x + Math.max(0, slotW - barW) / 2
        const by = bottom - heightPx

        if (count > 0) {
            ctx.globalAlpha = isPeak ? 1 : 0.9
            ctx.fillStyle = fill
            roundRect(ctx, bx, by, barW, heightPx, Math.min(3, barW / 2, heightPx / 2))
            ctx.fill()
            ctx.globalAlpha = 1
            if (isPeak) {
                ctx.strokeStyle = `rgba(196, 122, 26, ${0.45 + 0.55 * pulse})`
                ctx.lineWidth = compact ? 1 : 1.5
                roundRect(ctx, bx - 1, by - 1, barW + 2, heightPx + 2, Math.min(4, barW / 2))
                ctx.stroke()
            }
        }

        if (compact && reportCount > 0 && heightPx > 0) {
            ctx.fillStyle = '#c47a1a'
            ctx.beginPath()
            ctx.arc(x + slotW / 2, by + 1.4, 1.15, 0, Math.PI * 2)
            ctx.fill()
        } else if (reportCount > 0) {
            const cx = x + slotW / 2
            const cy = (heightPx > 0 ? by : bottom) - 7
            ctx.fillStyle = '#c47a1a'
            diamond(ctx, cx, cy, reportCount > 1 ? 4.2 : 3.4)
            ctx.fill()
            ctx.fillStyle = '#fff8ee'
            diamond(ctx, cx, cy, 1.3)
            ctx.fill()
        }

    }

    // Labels stay on the same clock hours while the window scrolls. Choosing them
    // from the current pixel gap makes the text swap during playback.
    if (!compact) {
    const slotsPerHour = 60 / playback.interval
    const hourStride = Math.max(1, Math.ceil(56 / Math.max(slotW * slotsPerHour, 1)))
    const labelStart = Math.max(0, start - hourStride * slotsPerHour)
    const labelEnd = Math.min(points.length, end + hourStride * slotsPerHour)
    for (let index = labelStart; index < labelEnd; index += 1) {
        const point = points[index]
        if (!point) continue
        const minute = point.start.slice(14, 16)
        if (playback.interval !== 60 && minute !== '00') continue
        const hour = Number(point.start.slice(11, 13))
        if (!Number.isFinite(hour) || hour % hourStride !== 0) continue
        const labelX = (index - viewStart) * slotW + slotW / 2
        if (labelX < -36 || labelX > width + 36) continue
        const dayStart = hour === 0 && minute === '00'
        const label = dayStart ? formatSlot(point.start, true).slice(0, 5) : formatSlot(point.start, false)
        ctx.fillStyle = dayStart ? '#0d2721' : '#698079'
        ctx.font = `${dayStart ? 700 : 500} 10px "Noto Sans TC", sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'alphabetic'
        ctx.fillText(label, Math.round(labelX), height - 7)
    }
    ctx.textAlign = 'left'
    }

    if (!compact) for (const particle of playback.particles) {
        const x = (particle.slot - viewStart) * slotW + slotW / 2 + particle.dx
        if (x < -8 || x > width + 8) continue
        ctx.globalAlpha = Math.max(0, particle.life)
        ctx.fillStyle = particle.kind === 'spark' ? '#c47a1a' : '#16866f'
        if (particle.kind === 'spark') {
            diamond(ctx, x, particle.y, particle.r)
            ctx.fill()
        } else {
            ctx.beginPath()
            ctx.arc(x, particle.y, particle.r, 0, Math.PI * 2)
            ctx.fill()
        }
    }
    ctx.globalAlpha = 1

    const playX = (playback.playhead - viewStart) * slotW
    const messageX = playback.messageHead == null ? null : (playback.messageHead - viewStart) * slotW
    if (playX >= -2 && playX <= width + 2) {
        ctx.strokeStyle = '#0d6655'
        ctx.lineWidth = compact ? 1.25 : 1.5
        ctx.beginPath()
        ctx.moveTo(playX, compact ? 1 : plotTop - 2)
        ctx.lineTo(playX, bottom)
        ctx.stroke()
        if (!compact) {
            ctx.fillStyle = '#0d6655'
            ctx.beginPath()
            ctx.moveTo(playX - 4.5, plotTop - 2)
            ctx.lineTo(playX + 4.5, plotTop - 2)
            ctx.lineTo(playX, plotTop + 5)
            ctx.closePath()
            ctx.fill()
        }
    }
    if (messageX != null && messageX >= -2 && messageX <= width + 2) {
        ctx.strokeStyle = NOW_COLOR
        ctx.lineWidth = compact ? 1.25 : 1.75
        ctx.beginPath()
        ctx.moveTo(messageX, compact ? 1 : plotTop - 2)
        ctx.lineTo(messageX, bottom)
        ctx.stroke()
        ctx.fillStyle = NOW_COLOR
        ctx.beginPath()
        ctx.arc(messageX, compact ? 2.2 : plotTop + 1, compact ? 2.2 : 3.2, 0, Math.PI * 2)
        ctx.fill()
    }

    if (!compact && playback.peakIndex >= 0 && playback.peakCount > 0) {
        const peakX = (playback.peakIndex - viewStart) * slotW
        const peakVisible = peakX >= -slotW && peakX <= width
        if (peakVisible) {
            const point = points[playback.peakIndex]
            const label = `Peak ${formatSlot(point.start, false)} · ${point.count}`
            ctx.font = '700 11px "Noto Sans TC", sans-serif'
            const textW = ctx.measureText(label).width
            const lx = clamp(peakX + slotW / 2 - textW / 2, 8, Math.max(8, width - textW - 8))
            ctx.fillStyle = 'rgba(255, 250, 244, 0.9)'
            roundRect(ctx, lx - 5, 4, textW + 10, 16, 8)
            ctx.fill()
            ctx.fillStyle = '#8a4e12'
            ctx.textBaseline = 'middle'
            ctx.fillText(label, lx, 12)
            ctx.textBaseline = 'alphabetic'
        } else if (playback.peakIndex < playback.viewStart) {
            playback.hitLeft = drawEdgeMarker(ctx, 'left', width)
        } else {
            playback.hitRight = drawEdgeMarker(ctx, 'right', width)
        }
    }
}

function revealHead(playback: Playback, head: number): void {
    const { visible, maxStart } = metrics(playback)
    const margin = Math.min(visible * 0.18, Math.max(0.5, visible - 0.5))
    if (head < playback.viewStart + margin) {
        playback.viewStart = clamp(head - margin, 0, maxStart)
    } else if (head > playback.viewStart + visible - margin) {
        playback.viewStart = clamp(head - (visible - margin), 0, maxStart)
    }
}

function focusCenter(playback: Playback): void {
    const { visible } = metrics(playback)
    playback.playhead = clamp(playback.viewStart + visible * 0.5, 0, Math.max(0, playback.points.length - 1))
}

function hitContains(hit: HitBox | null, x: number, y: number): boolean {
    if (!hit) return false
    return x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h
}

export default function MessageFlowTimeline({
    from,
    to,
    groupJid,
    active,
    focusMs = null,
    followFocus = false,
}: {
    from: string
    to: string
    groupJid: string | null
    active: boolean
    focusMs?: number | null
    followFocus?: boolean
}) {
    const [intervalMinutes, setIntervalMinutes] = useState<IntervalMinutes>(readInterval)
    const [visible, setVisible] = useState(readFlowVisible)
    const [live, setLive] = useState(readFlowLive)
    const [data, setData] = useState<MessageFlow | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [reducedMotion, setReducedMotion] = useState(() =>
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
    const [readout, setReadout] = useState('')
    const [slotIndex, setSlotIndex] = useState(0)
    const [hover, setHover] = useState<{ index: number; x: number; label: string } | null>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const expandedRef = useRef(visible)
    expandedRef.current = visible
    const focusMsRef = useRef<number | null>(focusMs)
    const followRef = useRef(followFocus)
    const requestId = useRef(0)
    const modeRef = useRef<PlaceMode>('reset')
    const anchorRef = useRef<string | null>(null)
    const pendingPlace = useRef<PlaceMode>('reset')
    const queryKeyRef = useRef('')
    const playback = useRef<Playback>({
        points: [],
        peakIndex: -1,
        peakCount: 0,
        viewStart: 0,
        playhead: 0,
        reduced: false,
        interval: 60,
        width: 0,
        height: 0,
        multiDay: false,
        particles: [],
        ambient: 0,
        compact: !readFlowVisible(),
        live: readFlowLive(),
        messageHead: null,
        lastLiveSlot: -1,
        lastLiveCount: 0,
        hitLeft: null,
        hitRight: null,
    })
    const dragRef = useRef<{ id: number; x: number; view: number; moved: boolean } | null>(null)
    const published = useRef({ slot: -1, readout: '' })

    const publish = useCallback(() => {
        const pb = playback.current
        const slot = clamp(Math.floor(pb.playhead), 0, Math.max(0, pb.points.length - 1))
        const point = pb.points[slot]
        const nextReadout = point ? readoutFor(point, pb.multiDay) : ''
        if (published.current.slot !== slot || published.current.readout !== nextReadout) {
            published.current.slot = slot
            published.current.readout = nextReadout
            setSlotIndex(slot)
            setReadout(nextReadout)
        }
    }, [])

    const paint = useCallback((now = performance.now()) => {
        const canvas = canvasRef.current
        const pb = playback.current
        if (!canvas) return
        const cssW = canvas.clientWidth
        const cssH = canvas.clientHeight
        if (cssW <= 0 || cssH <= 0) return
        const previousWidth = pb.width
        const previousVisible = previousWidth > 0 ? metrics(pb).visible : 0
        const fraction =
            previousVisible > 0 ? clamp((pb.playhead - pb.viewStart) / previousVisible, 0, 1) : 0.5
        pb.compact = !expandedRef.current
        pb.width = cssW
        pb.height = cssH
        if (previousWidth > 0 && Math.abs(previousWidth - cssW) > 1) {
            const { visible, maxStart } = metrics(pb)
            pb.viewStart = clamp(pb.playhead - visible * fraction, 0, maxStart)
        }
        if (focusMsRef.current != null) {
            pb.messageHead = playheadAt(pb.points, pb.interval, focusMsRef.current)
        }
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const bufferW = Math.floor(cssW * dpr)
        const bufferH = Math.floor(cssH * dpr)
        if (canvas.width !== bufferW || canvas.height !== bufferH) {
            canvas.width = bufferW
            canvas.height = bufferH
        }
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, cssW, cssH)
        drawScene(ctx, pb, now)
    }, [])

    const jumpToPeak = useCallback(() => {
        const pb = playback.current
        if (pb.peakIndex < 0) return
        if (pb.live) {
            pb.live = false
            setLive(false)
        }
        const { visible, maxStart } = metrics(pb)
        pb.playhead = pb.peakIndex
        pb.viewStart = clamp(pb.peakIndex - visible * 0.5, 0, maxStart)
        publish()
        paint()
    }, [paint, publish])

    const load = useCallback(
        async (signal: AbortSignal | undefined, mode: PlaceMode) => {
            const id = ++requestId.current
            try {
                const params = new URLSearchParams({
                    from,
                    to,
                    interval: String(intervalMinutes),
                })
                if (groupJid) params.set('group', groupJid)
                const response = await fetch(`/api/message-flow?${params}`, { signal })
                const body = (await response.json()) as MessageFlow
                if (id !== requestId.current) return
                if (!response.ok) throw new Error(body.error || `Could not load message flow (${response.status})`)
                pendingPlace.current = mode
                queryKeyRef.current = `${from}|${to}|${groupJid ?? ''}|${intervalMinutes}`
                setError(null)
                setData(body)
            } catch (reason) {
                if (id !== requestId.current || isAbort(reason)) return
                setError(reason instanceof Error ? reason.message : 'Could not load message flow')
            }
        },
        [from, to, groupJid, intervalMinutes]
    )

    useEffect(() => {
        const pb = playback.current
        if (pb.points.length === 0) {
            modeRef.current = 'reset'
            anchorRef.current = null
            return
        }
        const slot = Math.min(Math.floor(pb.playhead), pb.points.length - 1)
        anchorRef.current = pb.points[slot]?.start ?? null
        modeRef.current = anchorRef.current ? 'anchor' : 'keep'
    }, [from, to, groupJid])

    useEffect(() => {
        const media = window.matchMedia('(prefers-reduced-motion: reduce)')
        const apply = () => {
            playback.current.reduced = media.matches
            setReducedMotion(media.matches)
            if (media.matches) {
                playback.current.particles = []
                publish()
                paint()
            }
        }
        apply()
        media.addEventListener('change', apply)
        return () => media.removeEventListener('change', apply)
    }, [paint, publish])

    useEffect(() => {
        if (!active) return undefined
        const key = `${from}|${to}|${groupJid ?? ''}|${intervalMinutes}`
        if (queryKeyRef.current === key && playback.current.points.length > 0) return undefined
        const controller = new AbortController()
        void load(controller.signal, modeRef.current)
        return () => controller.abort()
    }, [active, from, groupJid, intervalMinutes, load, to])

    useVisibleInterval(() => {
        void load(undefined, 'keep')
    }, active ? 15_000 : null)

    useLayoutEffect(() => {
        if (!data || data.total === 0) return
        const pb = playback.current
        const { visible: oldVisible } = metrics(pb)
        const windowFraction = oldVisible > 0 ? clamp((pb.playhead - pb.viewStart) / oldVisible, 0, 1) : 0.72
        const slot = Math.floor(pb.playhead)
        const oldPoint = pb.points[slot]
        const minutesInto = oldPoint ? (pb.playhead - slot) * pb.interval : 0
        const anchor = oldPoint?.start ?? null
        const mode = pendingPlace.current
        pb.points = data.points
        pb.peakCount = data.peakCount
        pb.interval = data.intervalMinutes
        pb.multiDay = isMultiDay(data.points)
        pb.peakIndex = data.peakStart ? data.points.findIndex((point) => point.start === data.peakStart) : -1
        const canvas = canvasRef.current
        if (canvas) {
            pb.width = canvas.clientWidth
            pb.height = canvas.clientHeight
        }
        if (mode !== 'keep') {
            pb.lastLiveSlot = -1
            pb.lastLiveCount = 0
        }
        if (mode !== 'reset' && anchor) {
            if (mode !== 'keep') pb.particles = []
            const index = nearestIndex(pb.points, anchor)
            pb.playhead = clamp(index + minutesInto / pb.interval, 0, Math.max(0, pb.points.length - 0.001))
            const { visible, maxStart } = metrics(pb)
            pb.viewStart = clamp(pb.playhead - visible * windowFraction, 0, maxStart)
            if (pb.live) pinToNow(pb)
        } else {
            applyPlacement(pb, 'reset', null)
        }
        modeRef.current = 'keep'
        if (focusMsRef.current != null) {
            pb.messageHead = playheadAt(pb.points, pb.interval, focusMsRef.current)
            if (pb.messageHead != null && followRef.current && !pb.live) revealHead(pb, pb.messageHead)
        }
        publish()
        paint()
    }, [data, paint, publish])

    useEffect(() => {
        if (!active || !data || data.total === 0) return undefined
        const canvas = canvasRef.current
        if (!canvas) return undefined
        let frame = 0
        let last = performance.now()
        const tick = (now: number) => {
            const dt = Math.min(0.05, (now - last) / 1000)
            last = now
            const wasLive = playback.current.live
            if (playback.current.live) pinToNow(playback.current)
            if (!playback.current.reduced) step(playback.current, dt)
            if (!wasLive && playback.current.live) setLive(true)
            paint(now)
            publish()
            if (!playback.current.reduced || playback.current.live) frame = requestAnimationFrame(tick)
        }
        frame = requestAnimationFrame(tick)
        const observer = new ResizeObserver(() => paint())
        observer.observe(canvas)
        return () => {
            cancelAnimationFrame(frame)
            observer.disconnect()
        }
    }, [active, data, live, paint, publish, reducedMotion, visible])

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || !visible || !data || data.total === 0) return undefined
        const onWheel = (event: WheelEvent) => {
            event.preventDefault()
            const pb = playback.current
            releaseLive()
            const { slotW, maxStart } = metrics(pb)
            const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
            pb.viewStart = clamp(pb.viewStart + delta / slotW, 0, maxStart)
            focusCenter(pb)
            publish()
            paint()
        }
        canvas.addEventListener('wheel', onWheel, { passive: false })
        return () => canvas.removeEventListener('wheel', onWheel)
    }, [data, paint, publish, visible])

    useEffect(() => {
        try {
            localStorage.setItem(VISIBLE_KEY, visible ? '1' : '0')
        } catch {
            // The choice still applies for this visit.
        }
    }, [visible])

    useEffect(() => {
        try {
            localStorage.setItem(LIVE_KEY, live ? '1' : '0')
        } catch {
            // The choice still applies for this visit.
        }
    }, [live])

    const releaseLive = () => {
        if (!playback.current.live) return
        playback.current.live = false
        setLive(false)
    }

    useEffect(() => {
        focusMsRef.current = focusMs
        followRef.current = followFocus
        const pb = playback.current
        const head = focusMs == null ? null : playheadAt(pb.points, pb.interval, focusMs)
        pb.messageHead = head
        if (head != null && followFocus) {
            releaseLive()
            revealHead(pb, head)
        }
        paint()
    }, [focusMs, followFocus, paint])

    const chooseLive = (next: boolean) => {
        const pb = playback.current
        pb.live = next
        if (next) {
            pinToNow(pb)
            publish()
            paint()
        }
        setLive(next)
    }

    const chooseVisible = (next: boolean) => {
        setVisible(next)
    }

    const chooseInterval = (minutes: IntervalMinutes) => {
        if (minutes === intervalMinutes) return
        const point = playback.current.points[Math.round(playback.current.playhead)]
        anchorRef.current = point?.start ?? null
        modeRef.current = 'anchor'
        try {
            sessionStorage.setItem(STORAGE_KEY, String(minutes))
        } catch {
            // The choice still applies for this visit.
        }
        setIntervalMinutes(minutes)
    }

    const nudge = (direction: -1 | 1) => {
        const pb = playback.current
        releaseLive()
        const { maxStart } = metrics(pb)
        pb.viewStart = clamp(pb.viewStart + direction, 0, maxStart)
        focusCenter(pb)
        publish()
        paint()
    }

    const showHover = (event: PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current
        const pb = playback.current
        if (!canvas || pb.points.length === 0) return
        const x = event.clientX - canvas.getBoundingClientRect().left
        const { slotW } = metrics(pb)
        if (slotW <= 0) return
        const index = clamp(Math.floor(pb.viewStart + x / slotW), 0, pb.points.length - 1)
        const point = pb.points[index]
        if (!point) {
            setHover(null)
            return
        }
        const rightInset = pb.compact ? 52 : 36
        const center = clamp((index - pb.viewStart + 0.5) * slotW, 36, Math.max(36, canvas.clientWidth - rightInset))
        const label = formatSlot(point.start, pb.multiDay)
        setHover((current) =>
            current && current.index === index && current.label === label && Math.abs(current.x - center) < 0.5
                ? current
                : { index, x: center, label }
        )
    }

    const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
        if (!expandedRef.current) return
        setHover(null)
        releaseLive()
        dragRef.current = {
            id: event.pointerId,
            x: event.clientX,
            view: playback.current.viewStart,
            moved: false,
        }
        event.currentTarget.setPointerCapture(event.pointerId)
    }

    const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
        const drag = dragRef.current
        if (!drag || drag.id !== event.pointerId) {
            showHover(event)
            return
        }
        const dx = event.clientX - drag.x
        if (Math.abs(dx) > 4) drag.moved = true
        if (!drag.moved) return
        setHover(null)
        const pb = playback.current
        const { slotW, maxStart } = metrics(pb)
        pb.viewStart = clamp(drag.view - dx / slotW, 0, maxStart)
        focusCenter(pb)
        publish()
        paint()
    }

    const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
        if (!expandedRef.current) {
            chooseVisible(true)
            return
        }
        const drag = dragRef.current
        dragRef.current = null
        if (!drag || drag.moved) return
        const canvas = canvasRef.current
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        const x = event.clientX - rect.left
        const y = event.clientY - rect.top
        const pb = playback.current
        if (hitContains(pb.hitLeft, x, y) || hitContains(pb.hitRight, x, y)) {
            jumpToPeak()
            return
        }
        const { slotW } = metrics(pb)
        const index = clamp(Math.floor(pb.viewStart + x / slotW), 0, pb.points.length - 1)
        pb.playhead = index
        publish()
        paint()
    }

    if (error && !data) {
        return (
            <div className="flow-timeline flow-timeline-error" role="alert">
                <p>{error}</p>
                <button type="button" onClick={() => void load(undefined, 'reset')}>
                    Try again
                </button>
            </div>
        )
    }

    if (!data || data.total === 0) return null

    const peakPoint =
        data.peakStart != null ? data.points.find((point) => point.start === data.peakStart) : undefined
    const multiDay = isMultiDay(data.points)
    const peakLabel = peakPoint
        ? `Peak ${formatSlot(peakPoint.start, multiDay)} · ${peakPoint.count}`
        : 'Peak'

    return (
        <section className={visible ? 'flow-timeline' : 'flow-timeline is-collapsed'} aria-label="Message flow">
            {visible && <div className="flow-toolbar">
                <p className="flow-readout">{readout}</p>
                <div className="flow-toolbar-actions">
                    <div className="segmented-control flow-interval" role="group" aria-label="Flow interval">
                        {INTERVALS.map((item) => (
                            <button
                                key={item.minutes}
                                type="button"
                                className={intervalMinutes === item.minutes ? 'active' : ''}
                                aria-pressed={intervalMinutes === item.minutes}
                                onClick={() => chooseInterval(item.minutes)}
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>
                    <button
                        type="button"
                        className="flow-now-btn"
                        aria-pressed={live}
                        aria-label={live ? 'Release the line from the current time' : 'Keep the line on the current time'}
                        onClick={() => chooseLive(!live)}
                    >
                        Now
                    </button>
                    <button type="button" className="flow-peak-btn" onClick={jumpToPeak}>
                        <span className="flow-peak-long">{peakLabel}</span>
                        <span className="flow-peak-short">
                            {peakPoint ? `Peak ${formatSlot(peakPoint.start, false)}` : 'Peak'}
                        </span>
                    </button>
                </div>
                <button
                    type="button"
                    className="flow-visibility-btn"
                    aria-expanded={true}
                    aria-label="Collapse message flow"
                    onClick={() => chooseVisible(false)}
                >
                    <ChevronUpIcon />
                </button>
            </div>}
            <div className="flow-stage">
                <canvas
                    ref={canvasRef}
                    role="slider"
                    aria-label="Message flow timeline"
                    aria-valuemin={0}
                    aria-valuemax={Math.max(0, data.points.length - 1)}
                    aria-valuenow={slotIndex}
                    aria-valuetext={readout}
                    tabIndex={0}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={() => {
                        dragRef.current = null
                        setHover(null)
                    }}
                    onPointerLeave={() => setHover(null)}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowLeft') {
                            event.preventDefault()
                            nudge(-1)
                        } else if (event.key === 'ArrowRight') {
                            event.preventDefault()
                            nudge(1)
                        }
                    }}
                />
                {hover && (
                    <div className="flow-tip" style={{ left: hover.x }}>
                        {hover.label}
                    </div>
                )}
            </div>
            {!visible && (
                <button
                    type="button"
                    className="flow-visibility-btn"
                    aria-expanded={false}
                    aria-label="Expand message flow"
                    onClick={() => chooseVisible(true)}
                >
                    <ChevronDownIcon />
                </button>
            )}
        </section>
    )
}

function ChevronUpIcon() {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 14.5 12 8.5l6 6" />
        </svg>
    )
}

function ChevronDownIcon() {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 9.5 12 15.5l6-6" />
        </svg>
    )
}

