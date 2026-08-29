import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../public/icons')

function crc32(buffer) {
    let crc = ~0
    for (const byte of buffer) {
        crc ^= byte
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
        }
    }
    return ~crc >>> 0
}

function chunk(type, data) {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
}

function encodePng(width, height, rgba) {
    const rows = []
    for (let y = 0; y < height; y += 1) {
        rows.push(Buffer.from([0]))
        rows.push(rgba.subarray(y * width * 4, (y + 1) * width * 4))
    }
    const header = Buffer.alloc(13)
    header.writeUInt32BE(width, 0)
    header.writeUInt32BE(height, 4)
    header[8] = 8
    header[9] = 6
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ])
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
}

function mix(from, to, t) {
    return from.map((channel, index) => channel + (to[index] - channel) * t)
}

function sdBox(px, py, x, y, width, height) {
    const dx = Math.abs(px - (x + width / 2)) - width / 2
    const dy = Math.abs(py - (y + height / 2)) - height / 2
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0)
}

function sdRoundedBox(px, py, x, y, width, height, radius) {
    return sdBox(px, py, x + radius, y + radius, width - radius * 2, height - radius * 2) - radius
}

function sdSegment(px, py, x1, y1, x2, y2) {
    const vx = x2 - x1
    const vy = y2 - y1
    const length = vx * vx + vy * vy || 1
    const t = clamp(((px - x1) * vx + (py - y1) * vy) / length, 0, 1)
    return Math.hypot(px - (x1 + vx * t), py - (y1 + vy * t))
}

function coverage(distance) {
    return clamp(0.5 - distance, 0, 1)
}

function drawIcon(size, { shape, glyphScale }) {
    const rgba = Buffer.alloc(size * size * 4)
    const inset = shape === 'rounded' ? size * 0.06 : 0
    const box = size - inset * 2
    const radius = shape === 'rounded' ? box * 0.22 : 0
    const glyph = size * glyphScale
    const gx = (size - glyph) / 2
    const gy = (size - glyph) / 2
    const scale = glyph / 24
    const stroke = 1.8 * scale

    const map = (x, y) => [gx + x * scale, gy + y * scale]
    const [bx, by] = map(4, 7.5)
    const [lx, ly] = map(3, 4.5)
    const [s1x, s1y] = map(9, 11)
    const [s2x, s2y] = map(15, 11)
    const bodyW = 16 * scale
    const bodyH = 12 * scale
    const lidW = 18 * scale
    const lidH = 3 * scale

    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const px = x + 0.5
            const py = y + 0.5
            const t = clamp((px + py) / (size * 2), 0, 1)
            const fill = mix([33, 163, 133], [11, 109, 88], t)
            const outside =
                shape === 'rounded' ? sdRoundedBox(px, py, inset, inset, box, box, radius) : -1
            const bg = coverage(outside)
            const glyphDist = Math.min(
                Math.abs(sdBox(px, py, bx, by, bodyW, bodyH)) - stroke / 2,
                Math.abs(sdBox(px, py, lx, ly, lidW, lidH)) - stroke / 2,
                sdSegment(px, py, s1x, s1y, s2x, s2y) - stroke / 2
            )
            const fg = coverage(glyphDist)
            const a = shape === 'rounded' ? bg : 1
            const r = fill[0] * (1 - fg) + 255 * fg
            const g = fill[1] * (1 - fg) + 255 * fg
            const b = fill[2] * (1 - fg) + 255 * fg
            const i = (y * size + x) * 4
            rgba[i] = Math.round(r)
            rgba[i + 1] = Math.round(g)
            rgba[i + 2] = Math.round(b)
            rgba[i + 3] = Math.round(a * 255)
        }
    }

    return encodePng(size, size, rgba)
}

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'icon-192.png'), drawIcon(192, { shape: 'rounded', glyphScale: 0.46 }))
writeFileSync(join(outDir, 'icon-512.png'), drawIcon(512, { shape: 'rounded', glyphScale: 0.46 }))
writeFileSync(
    join(outDir, 'icon-maskable-512.png'),
    drawIcon(512, { shape: 'full', glyphScale: 0.5 })
)
writeFileSync(
    join(outDir, 'apple-touch-icon.png'),
    drawIcon(180, { shape: 'full', glyphScale: 0.5 })
)
writeFileSync(join(outDir, 'favicon-32.png'), drawIcon(32, { shape: 'rounded', glyphScale: 0.46 }))
console.log(`Wrote icons to ${outDir}`)
