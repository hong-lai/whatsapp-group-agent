import {
    isHostedLidUser,
    isHostedPnUser,
    isLidUser,
    isPnUser,
    jidDecode,
    jidNormalizedUser,
} from '@whiskeysockets/baileys'
import { redis } from '../../../packages/shared/src/redis.js'

const LOOKUP_JID =
    /^[0-9]+(?:_[0-9]+)?(?::[0-9]+)?@(s\.whatsapp\.net|c\.us|lid|hosted|hosted\.lid)$/
const PHONE_USER = /^\d{7,15}$/
const PARTICIPANT_CACHE_MS = 60_000

type ParticipantLike = {
    id?: string
    lid?: string
    phoneNumber?: string
}

let participantPhones: Map<string, string> | null = null
let participantPhonesAt = 0

export function isLookupJid(jid: string): boolean {
    return LOOKUP_JID.test(jid)
}

function pnJid(jid: string | null | undefined): string | null {
    if (!jid) return null
    const normalized = jidNormalizedUser(jid)
    if (!normalized || !(isPnUser(normalized) || isHostedPnUser(normalized))) return null
    const user = jidDecode(normalized)?.user ?? ''
    return PHONE_USER.test(user) ? normalized : null
}

function lidJid(jid: string | null | undefined): string | null {
    if (!jid) return null
    const normalized = jidNormalizedUser(jid)
    if (!normalized || !(isLidUser(normalized) || isHostedLidUser(normalized))) return null
    return normalized
}

function formatPhone(pn: string): string | null {
    const user = jidDecode(pn)?.user ?? ''
    return PHONE_USER.test(user) ? `+${user}` : null
}

function rememberPair(map: Map<string, string>, participant: ParticipantLike): void {
    const pn = pnJid(participant.phoneNumber) || pnJid(participant.id)
    const lid = lidJid(participant.lid) || lidJid(participant.id)
    if (pn && lid) map.set(lid, pn)
}

async function scanGroupKeys(): Promise<string[]> {
    const keys: string[] = []
    let cursor = '0'
    do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', 'group:*@g.us', 'COUNT', 100)
        cursor = next
        keys.push(...batch)
    } while (cursor !== '0')
    return keys
}

/** LID → phone JID from cached group participants, the source messages actually use. */
async function loadParticipantPhones(): Promise<Map<string, string>> {
    if (participantPhones && Date.now() - participantPhonesAt < PARTICIPANT_CACHE_MS) {
        return participantPhones
    }
    const map = new Map<string, string>()
    const keys = await scanGroupKeys()
    if (keys.length > 0) {
        const rawGroups = await redis.mget(...keys)
        for (const raw of rawGroups) {
            if (!raw) continue
            try {
                const meta = JSON.parse(raw) as { participants?: ParticipantLike[] }
                for (const participant of meta.participants ?? []) rememberPair(map, participant)
            } catch {
                // skip corrupt group cache entries
            }
        }
    }
    participantPhones = map
    participantPhonesAt = Date.now()
    return map
}

async function phoneJidForLid(lid: string): Promise<string | null> {
    const mapped = pnJid(await redis.get(`lid:pn:${lid}`))
    if (mapped) return mapped
    const fromGroups = (await loadParticipantPhones()).get(lid)
    if (!fromGroups) return null
    const pipeline = redis.pipeline()
    pipeline.set(`lid:pn:${lid}`, fromGroups, 'NX')
    pipeline.set(`pn:lid:${fromGroups}`, lid, 'NX')
    await pipeline.exec()
    return fromGroups
}

/** Phone for a sender JID. LID senders resolve through the lid→phone map, then group participants. */
export async function resolveSenderPhone(jid: string): Promise<string | null> {
    const normalized = jidNormalizedUser(jid)
    if (!normalized) return null
    const direct = pnJid(normalized)
    if (direct) return formatPhone(direct)
    if (!lidJid(normalized)) return null
    const pn = await phoneJidForLid(normalized)
    return pn ? formatPhone(pn) : null
}
