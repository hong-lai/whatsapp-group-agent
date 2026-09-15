import makeWASocket, {
    DisconnectReason,
    type BaileysEventMap,
    type GroupMetadata,
    isJidGroup,
    jidNormalizedUser,
    proto,
    useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import { mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import pino from 'pino'
import {
    getLatestGroupMessage,
    getStoredMessageForGetMessage,
    initDb,
} from '../../../packages/shared/src/db/index.js'
import { loadFilenameFormatSettings } from '../../../packages/shared/src/filenameFormat.js'
import { log } from '../../../packages/shared/src/log.js'
import {
    markIngestShutdown,
    noteConnected,
    noteConnecting,
    noteDisconnected,
    startConnectionHeartbeat,
} from '../../../packages/shared/src/connectionStatus.js'
import { createCatchup, asCatchupMessage } from './catchup.js'
import { config, matchesGroupPattern } from './config.js'
import {
    addSkippedGroup,
    clearParticipatingMeta,
    clearSkippedGroups,
    getGroupMetadata,
    getParticipatingMeta,
    listParticipatingMeta,
    setParticipatingMeta,
} from './cache.js'
import { rememberContacts, rememberLidMappings } from './contacts.js'
import {
    applyEditUpdate,
    applyIncomingEdit,
    isEditEnvelope,
} from './edits.js'
import { forgetGroup, mergeDefined, ownJid, persistMatchingGroup, refreshGroup } from './groups.js'
import {
    bumpMediaSocketGeneration,
    markDeletedAndRenameMedia,
    recoverPendingMediaDownloads,
} from './media.js'
import { historyCutoffSeconds, processMessage, resolveGroupMetadata, unixSeconds } from './processMessage.js'
import { createSerialQueue } from './rateLimit.js'

function clearAuthContents(dir: string): void {
    mkdirSync(dir, { recursive: true })
    for (const name of readdirSync(dir)) {
        rmSync(join(dir, name), { recursive: true, force: true })
    }
}

function hasIngestWork(events: Partial<BaileysEventMap>): boolean {
    return Boolean(
        events['messaging-history.set'] ||
            events['messaging-history.status'] ||
            events['lid-mapping.update'] ||
            events['contacts.upsert'] ||
            events['contacts.update'] ||
            events['messages.upsert'] ||
            events['messages.update'] ||
            events['messages.delete'] ||
            events['chats.upsert'] ||
            events['chats.update'] ||
            events['chats.delete'] ||
            events['groups.upsert'] ||
            events['groups.update'] ||
            events['group-participants.update']
    )
}

const RECONNECT_MIN_MS = 2_000
const RECONNECT_MAX_MS = 60_000
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let reconnectInFlight = false
let lastDisconnectLogKey = ''
let lastDisconnectLogAt = 0
let suppressedDisconnectLogs = 0

function disconnectLogKey(statusCode: number | undefined, loggedOut: boolean): string {
    return `${statusCode ?? 'unknown'}:${loggedOut ? 1 : 0}`
}

function scheduleReconnect(immediate = false): void {
    if (reconnectInFlight || reconnectTimer) return
    const delay = immediate
        ? 0
        : Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(reconnectAttempt, 5))
    reconnectAttempt += 1
    if (delay > 0) {
        log.info({ attempt: reconnectAttempt, delayMs: delay }, 'whatsapp.reconnect_scheduled')
    }
    reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        reconnectInFlight = true
        void connectToWhatsApp()
            .catch((err) => {
                log.warn({ err, attempt: reconnectAttempt }, 'whatsapp.reconnect_failed')
                reconnectInFlight = false
                scheduleReconnect()
            })
            .finally(() => {
                reconnectInFlight = false
            })
    }, delay)
}

async function connectToWhatsApp() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
    }
    void noteConnecting()
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir)

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        cachedGroupMetadata: async (jid) => getGroupMetadata(jid),
        syncFullHistory: true,
        getMessage: async (key) => {
            if (!key.id) return undefined
            const stored = await getStoredMessageForGetMessage(key.id)
            if (!stored) return undefined
            const message: proto.IMessage = {}
            if (stored.text) message.conversation = stored.text
            if (stored.messageSecret) {
                try {
                    message.messageContextInfo = {
                        messageSecret: new Uint8Array(JSON.parse(stored.messageSecret) as number[]),
                    }
                } catch {
                    // Malformed secret — still return text for send retries.
                }
            }
            return message.conversation || message.messageContextInfo ? message : undefined
        },
    })
    const catchup = createCatchup(sock)
    const runIngest = createSerialQueue()
    let participatingReady: Promise<void> | undefined

    async function ensureParticipatingGroups(): Promise<void> {
        if (!participatingReady) {
            participatingReady = cacheParticipatingGroups().catch((err) => {
                participatingReady = undefined
                throw err
            })
        }
        await participatingReady
    }

    function handleConnectionUpdate(update: BaileysEventMap['connection.update']): void {
        const { connection, lastDisconnect, qr } = update
        if (qr) {
            log.info('whatsapp.qr_ready')
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'connecting') {
            void noteConnecting()
        } else if (connection === 'close') {
            const boom = lastDisconnect?.error as Boom | undefined
            const statusCode = boom?.output?.statusCode
            const loggedOut = statusCode === DisconnectReason.loggedOut
            const restartRequired = statusCode === DisconnectReason.restartRequired
            const detail = loggedOut
                ? 'Logged out'
                : restartRequired
                  ? 'Restart required'
                  : statusCode
                    ? `Connection closed (${statusCode})`
                    : 'Connection closed'
            const key = disconnectLogKey(statusCode, loggedOut)
            const now = Date.now()
            const sameAsLast = key === lastDisconnectLogKey
            const recentlyLogged = now - lastDisconnectLogAt < 30_000
            if (loggedOut) {
                log.warn({ statusCode, loggedOut }, 'whatsapp.logged_out')
                clearAuthContents(config.authDir)
                lastDisconnectLogKey = key
                lastDisconnectLogAt = now
                suppressedDisconnectLogs = 0
            } else if (restartRequired) {
                log.info({ statusCode }, 'whatsapp.restart_required')
                lastDisconnectLogKey = key
                lastDisconnectLogAt = now
                suppressedDisconnectLogs = 0
            } else if (!sameAsLast || !recentlyLogged) {
                log.warn(
                    {
                        statusCode,
                        detail,
                        attempt: reconnectAttempt,
                        ...(suppressedDisconnectLogs > 0
                            ? { suppressedSinceLastLog: suppressedDisconnectLogs }
                            : {}),
                    },
                    'whatsapp.disconnected'
                )
                lastDisconnectLogKey = key
                lastDisconnectLogAt = now
                suppressedDisconnectLogs = 0
            } else {
                suppressedDisconnectLogs += 1
                log.debug({ statusCode, detail, attempt: reconnectAttempt }, 'whatsapp.disconnected')
            }
            void noteDisconnected(detail)
            catchup.stop()
            bumpMediaSocketGeneration()
            // restartRequired: reconnect ASAP; otherwise back off so offline phone
            // does not spin-connect and flood logs.
            scheduleReconnect(restartRequired || loggedOut)
        } else if (connection === 'open') {
            reconnectAttempt = 0
            lastDisconnectLogKey = ''
            suppressedDisconnectLogs = 0
            log.info({ jid: ownJid(sock) }, 'whatsapp.connected')
            void noteConnected()
            void runIngest(() => ensureParticipatingGroups())
            void recoverPendingMediaDownloads(sock)
        }
    }

    async function cacheParticipatingGroups(): Promise<void> {
        await clearSkippedGroups()
        await clearParticipatingMeta()
        const response = await sock.groupFetchAllParticipating()
        let cached = 0
        const trackedJids: string[] = []
        for (const key in response) {
            const metadata = response[key]
            if (!metadata) continue
            await setParticipatingMeta(metadata.id, metadata)
        }
        for (const metadata of await listParticipatingMeta()) {
            if (await persistMatchingGroup(metadata)) {
                cached += 1
                trackedJids.push(metadata.id)
            }
        }
        catchup.setTrackedGroups(trackedJids)
        log.info(
            {
                matchingGroups: cached,
                pattern: config.groupPatternSource,
                catchupBackfillSeconds: config.catchupBackfillSeconds,
            },
            'groups.cached'
        )
        catchup.noteConnected()
    }

    async function ingestEvents(events: Partial<BaileysEventMap>): Promise<void> {
        const history = events['messaging-history.set']
        if (history) {
            await ensureParticipatingGroups()
            const { messages, contacts, syncType, lidPnMappings } = history
            const started = Date.now()
            const counts = { saved: 0, reaction: 0, ignored: 0, error: 0, edited: 0, tooOld: 0 }
            const latestBefore = new Map<string, number | undefined>()
            const cutoff = historyCutoffSeconds()

            await rememberLidMappings(lidPnMappings)
            await rememberContacts(contacts)

            for (const m of messages || []) {
                if (unixSeconds(m.messageTimestamp) < cutoff) {
                    counts.tooOld += 1
                    continue
                }
                const groupJid = m.key.remoteJid
                if (groupJid && !latestBefore.has(groupJid)) {
                    const latest = await getLatestGroupMessage(groupJid)
                    latestBefore.set(groupJid, latest?.timestamp)
                }
                counts[await processMessage(m, sock, true, (trackedJid) => {
                    catchup.setTrackedGroups([trackedJid])
                })] += 1
            }
            for (const m of messages || []) {
                const result = await applyIncomingEdit(m, true)
                if (result === 'applied') counts.edited += 1
            }
            await catchup.considerHistoryBatch(messages || [], syncType, latestBefore)
            catchup.noteHistoryChunk(syncType)
            log.info({ syncType, ms: Date.now() - started, ...counts }, 'history.sync.done')
        }

        if (events['lid-mapping.update']) {
            await rememberLidMappings([events['lid-mapping.update']])
        }
        if (events['contacts.upsert']) {
            await rememberContacts(events['contacts.upsert'])
        }
        if (events['contacts.update']) {
            await rememberContacts(events['contacts.update'])
        }

        for (const chat of events['chats.upsert'] || []) {
            const last = asCatchupMessage(chat.messages?.[0]?.message)
            if (last) {
                catchup.noteChatHead(last)
                await catchup.considerMessage(last, 'chat.upsert')
            }
        }
        for (const chat of events['chats.update'] || []) {
            const last = asCatchupMessage(chat.messages?.[0]?.message)
            if (last) {
                catchup.noteChatHead(last)
                await catchup.considerMessage(last, 'chat.update')
            }
        }

        const upsert = events['messages.upsert']
        if (upsert && (upsert.type === 'notify' || upsert.type === 'append')) {
            const isHistory = upsert.type === 'append' || Boolean(upsert.requestId)
            const track = (groupJid: string) => catchup.setTrackedGroups([groupJid])
            for (const m of upsert.messages) {
                const groupJid = m.key.remoteJid
                if (!groupJid || !isJidGroup(groupJid) || isEditEnvelope(m.message)) continue
                const meta = await resolveGroupMetadata(groupJid, sock, !isHistory)
                if (meta && matchesGroupPattern(meta.subject)) track(groupJid)
            }
            for (const m of upsert.messages) {
                if (!isEditEnvelope(m.message)) {
                    catchup.noteChatHead(m)
                    await catchup.considerMessage(
                        m,
                        upsert.requestId ? 'phone_unavailable' : upsert.type
                    )
                }
            }
            for (const m of upsert.messages) {
                await processMessage(m, sock, isHistory, track)
            }
            for (const m of upsert.messages) {
                await applyIncomingEdit(m, isHistory)
            }
        }

        if (events['messages.update']) {
            const deletedIds: string[] = []
            for (const u of events['messages.update']) {
                if (u.update.messageStubType === 1 && u.key.id) {
                    deletedIds.push(u.key.id)
                }
                if (u.update.message) {
                    await applyEditUpdate(u.key, u.update.message)
                }
            }
            if (deletedIds.length > 0) {
                await markDeletedAndRenameMedia(deletedIds)
                log.info({ count: deletedIds.length, messageIds: deletedIds }, 'messages.deleted')
            }
        }

        const deleted = events['messages.delete']
        if (deleted) {
            if ('keys' in deleted) {
                const ids = deleted.keys.map((k) => k.id).filter((id): id is string => Boolean(id))
                await markDeletedAndRenameMedia(ids)
                log.info({ count: ids.length, messageIds: ids }, 'messages.deleted')
            } else {
                log.warn({ groupJid: deleted.jid }, 'messages.deleted_all')
            }
        }

        for (const group of events['groups.upsert'] || []) {
            const tracked = await persistMatchingGroup(group)
            if (tracked) {
                catchup.setTrackedGroups([group.id])
                log.info({ groupJid: group.id, groupName: group.subject }, 'group.tracked')
            }
        }

        for (const event of events['groups.update'] || []) {
            if (!event?.id) continue
            const previous =
                (await getGroupMetadata(event.id)) ?? (await getParticipatingMeta(event.id))
            if (previous) {
                const merged = mergeDefined(previous, event as Partial<GroupMetadata>)
                if (event.subject && event.subject !== previous.subject) {
                    log.info(
                        {
                            groupJid: event.id,
                            from: previous.subject,
                            to: event.subject,
                        },
                        'group.renamed'
                    )
                }
                const tracked = await persistMatchingGroup(merged)
                if (tracked) catchup.setTrackedGroups([event.id])
                continue
            }
            if (event.subject && matchesGroupPattern(event.subject)) {
                const metadata = await refreshGroup(sock, event.id, 'groups.update-matched')
                if (metadata && matchesGroupPattern(metadata.subject)) {
                    catchup.setTrackedGroups([event.id])
                    log.info(
                        { groupJid: event.id, groupName: metadata.subject },
                        'group.tracked'
                    )
                }
                continue
            }
            await addSkippedGroup(event.id)
        }

        const participants = events['group-participants.update']
        if (participants) {
            const me = ownJid(sock)
            const removedSelf =
                participants.action === 'remove' &&
                Boolean(me) &&
                participants.participants.some((p) => jidNormalizedUser(p.id) === me)

            if (removedSelf) {
                await forgetGroup(participants.id, 'removed from group')
            } else {
                const cached = await getGroupMetadata(participants.id)
                if (cached) {
                    const metadata = await refreshGroup(sock, participants.id, 'participants.update')
                    if (metadata) {
                        log.debug(
                            {
                                groupJid: participants.id,
                                groupName: metadata.subject,
                                action: participants.action,
                                participants: participants.participants.length,
                            },
                            'group.participants_updated'
                        )
                    }
                }
            }
        }

        for (const jid of events['chats.delete'] || []) {
            if (isJidGroup(jid)) {
                await forgetGroup(jid, 'chats.delete')
            }
        }

        if (events['messaging-history.status']) {
            catchup.noteHistoryStatus(
                events['messaging-history.status'].syncType,
                events['messaging-history.status'].status
            )
        }
    }

    sock.ev.process(async (events) => {
        if (events['creds.update']) {
            await saveCreds()
        }
        if (events['connection.update']) {
            handleConnectionUpdate(events['connection.update'])
        }
        if (hasIngestWork(events)) {
            void runIngest(() => ingestEvents(events))
        }
    })
}


;(async () => {
    try {
        log.info(
            {
                pattern: config.groupPatternSource,
                logLevel: config.logLevel,
                skipMediaDownload: config.skipMediaDownload,
            },
            'ingest.starting'
        )
        await initDb()
        await loadFilenameFormatSettings()
        startConnectionHeartbeat()
        const shutdown = async (signal: string) => {
            await markIngestShutdown(`ingest stopped (${signal})`)
            process.exit(0)
        }
        process.on('SIGINT', () => {
            void shutdown('SIGINT')
        })
        process.on('SIGTERM', () => {
            void shutdown('SIGTERM')
        })
        await connectToWhatsApp()
    } catch (err) {
        log.error({ err }, 'ingest.start_failed')
        await markIngestShutdown('ingest failed to start')
        process.exit(1)
    }
})()
