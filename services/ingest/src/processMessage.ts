import {
    getContentType,
    isJidGroup,
    jidNormalizedUser,
    proto,
    type GroupMetadata,
    type WAMessage,
    type WASocket,
} from '@whiskeysockets/baileys'
import {
    attachNearbyAlbumMedia,
    getMessageMediaState,
    insertMessage,
    markMessageForwarded,
    nextAlbumIndex,
    removeReaction,
    resolveAlbumParent,
    updateAlbumExpected,
    updateAlbumLink,
    upsertGroup,
    upsertReaction,
    upsertSenders,
} from '../../../packages/shared/src/db/index.js'
import { log } from '../../../packages/shared/src/log.js'
import { enqueueMessageEvent } from '../../../packages/shared/src/queue/index.js'
import { getGroupMetadata, getParticipatingMeta, isSkippedGroup, addSkippedGroup, setSenderDisplayNames } from './cache.js'
import { config, matchesGroupPattern } from './config.js'
import {
    cachedSenderName,
    isPersonJid,
    linkedJids,
    nameFromGroup,
    ownUser,
    rememberMessageSender,
    usableDisplayName,
} from './contacts.js'
import {
    applyPlaintextEdit,
    extractMessageSecret,
    flushPendingEdits,
    isEditEnvelope,
    isEditedWrapper,
    rememberMessageSecret,
    textFromMessage,
} from './edits.js'
import { persistMatchingGroup, refreshGroup } from './groups.js'
import {
    contentForIngest,
    fileTypes,
    isAlbumMediaType,
    isLivePhotoMotionVideo,
    originalMediaName,
    storeMediaFile,
} from './media.js'

export function unixSeconds(value: unknown): number {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return Math.floor(Date.now() / 1000)
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

export function historyCutoffSeconds(): number {
    return Math.floor(Date.now() / 1000) - config.catchupBackfillSeconds
}

function secondsFromMillis(value: unknown, fallback: number): number {
    const millis = Number(value)
    return Number.isFinite(millis) && millis > 0 ? Math.floor(millis / 1000) : fallback
}

function asAlbumIndex(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) {
        return Math.trunc(Number(value))
    }
    if (typeof value === 'bigint') return Number(value)
    if (
        value &&
        typeof value === 'object' &&
        'toNumber' in value &&
        typeof (value as { toNumber: unknown }).toNumber === 'function'
    ) {
        const n = (value as { toNumber: () => number }).toNumber()
        return Number.isFinite(n) ? Math.trunc(n) : null
    }
    return null
}

function messageLayers(
    message: proto.IMessage | null | undefined
): Array<proto.IMessage | null | undefined> {
    const layers: Array<proto.IMessage | null | undefined> = []
    let current = message
    for (let i = 0; i < 6 && current; i += 1) {
        layers.push(current)
        current =
            current.associatedChildMessage?.message ||
            current.ephemeralMessage?.message ||
            current.viewOnceMessage?.message ||
            current.viewOnceMessageV2?.message ||
            current.viewOnceMessageV2Extension?.message ||
            current.editedMessage?.message ||
            current.documentWithCaptionMessage?.message ||
            undefined
    }
    return layers
}

function associationTypeOf(value: unknown): number | null {
    if (value == null) return null
    if (typeof value === 'object' && value !== null && 'toNumber' in value) {
        try {
            return Number((value as { toNumber: () => number }).toNumber())
        } catch {
            return null
        }
    }
    const n = Number(value)
    return Number.isFinite(n) ? n : null
}

function albumAssociationOf(
    ...messages: Array<proto.IMessage | null | undefined>
): { parentId: string | null; index: number | null } {
    for (const message of messages) {
        for (const layer of messageLayers(message)) {
            const raw = layer?.messageContextInfo?.messageAssociation as
                | (proto.IMessageAssociation & {
                      message_index?: unknown
                      parent_message_key?: { id?: string | null } | null
                      association_type?: unknown
                  })
                | null
                | undefined
            if (!raw) continue
            const parentId = raw.parentMessageKey?.id || raw.parent_message_key?.id || null
            if (!parentId) continue
            const type = associationTypeOf(raw.associationType ?? raw.association_type)
            // Native album children carry MEDIA_ALBUM. Some payloads omit the enum
            // (undefined) or leave UNKNOWN while still setting parentMessageKey.
            if (
                type != null &&
                type !== proto.MessageAssociation.AssociationType.UNKNOWN &&
                type !== proto.MessageAssociation.AssociationType.MEDIA_ALBUM
            ) {
                continue
            }
            return {
                parentId,
                index: asAlbumIndex(raw.messageIndex ?? raw.message_index),
            }
        }
    }
    return { parentId: null, index: null }
}

function albumMessageFields(
    album: proto.Message.IAlbumMessage | null | undefined
): Record<string, unknown> | null {
    if (!album) return null
    if (typeof (album as proto.Message.AlbumMessage).toJSON === 'function') {
        return (album as proto.Message.AlbumMessage).toJSON() as Record<string, unknown>
    }
    return album as Record<string, unknown>
}

function albumExpectedOf(
    ...messages: Array<proto.IMessage | null | undefined>
): { images: number | null; videos: number | null } {
    for (const message of messages) {
        for (const layer of messageLayers(message)) {
            const record = albumMessageFields(layer?.albumMessage)
            if (!record) continue
            const images = asAlbumIndex(record.expectedImageCount ?? record.expected_image_count)
            const videos = asAlbumIndex(record.expectedVideoCount ?? record.expected_video_count)
            const hasImages = images != null && images > 0
            const hasVideos = videos != null && videos > 0
            // History sync often omits these fields. protobufjs then surfaces the
            // uint32 default 0, which must not be stored as a real slot limit.
            if (!hasImages && !hasVideos) continue
            return {
                images: hasImages ? images : images === 0 ? 0 : null,
                videos: hasVideos ? videos : videos === 0 ? 0 : null,
            }
        }
    }
    return { images: null, videos: null }
}
function contextInfoOf(content: proto.IMessage | null | undefined): proto.IContextInfo | undefined {
    if (!content) return undefined
    return (
        content.extendedTextMessage?.contextInfo ||
        content.imageMessage?.contextInfo ||
        content.videoMessage?.contextInfo ||
        content.ptvMessage?.contextInfo ||
        content.documentMessage?.contextInfo ||
        content.audioMessage?.contextInfo ||
        content.stickerMessage?.contextInfo ||
        content.buttonsMessage?.contextInfo ||
        content.templateMessage?.contextInfo ||
        content.listMessage?.contextInfo ||
        content.interactiveMessage?.contextInfo ||
        content.contactMessage?.contextInfo ||
        content.contactsArrayMessage?.contextInfo ||
        content.locationMessage?.contextInfo ||
        content.liveLocationMessage?.contextInfo ||
        content.albumMessage?.contextInfo ||
        undefined
    )
}

function isForwardedContent(content: proto.IMessage | null | undefined): boolean {
    const ctx = contextInfoOf(content)
    if (!ctx) return false
    return Boolean(
        ctx.isForwarded ||
            (ctx.forwardingScore ?? 0) > 0 ||
            ctx.forwardedNewsletterMessageInfo ||
            ctx.businessMessageForwardInfo
    )
}

function mentionedJidsOf(content: proto.IMessage | null | undefined): string[] {
    const ctx = contextInfoOf(content)
    const mentioned = (ctx?.mentionedJid || []).filter(isPersonJid).map((jid) => jidNormalizedUser(jid))
    const quoted = ctx?.quotedMessage ? mentionedJidsOf(ctx.quotedMessage) : []
    const seen = new Set<string>()
    const out: string[] = []
    for (const jid of [...mentioned, ...quoted]) {
        if (seen.has(jid)) continue
        seen.add(jid)
        out.push(jid)
    }
    return out
}
export async function resolveGroupMetadata(
    jid: string,
    sock: WASocket,
    allowFetch: boolean
): Promise<GroupMetadata | undefined> {
    const cached = await getGroupMetadata(jid)
    const participating = await getParticipatingMeta(jid)
    const knownNonMatching = await isSkippedGroup(jid)
    if (cached) return cached
    if (participating) {
        if (matchesGroupPattern(participating.subject)) {
            await persistMatchingGroup(participating)
            return participating
        }
        await addSkippedGroup(jid)
        return undefined
    }
    if (knownNonMatching || !allowFetch) return undefined
    return refreshGroup(sock, jid, 'processMessage')
}

export async function processMessage(
    m: WAMessage,
    sock: WASocket,
    isHistory = false,
    onTracked?: (groupJid: string) => void
): Promise<'ignored' | 'saved' | 'reaction' | 'error' | 'edited'> {
    if (!m.message || !m.key.remoteJid) return 'ignored'
    if (isEditEnvelope(m.message)) return 'ignored'

    const jid = m.key.remoteJid
    if (!isJidGroup(jid)) return 'ignored'

    const groupMetadata = await resolveGroupMetadata(jid, sock, !isHistory)
    if (!groupMetadata) return 'ignored'

    const groupName = groupMetadata.subject
    if (!matchesGroupPattern(groupName)) return 'ignored'
    onTracked?.(jid)

    const messageId = m.key.id
    const content = contentForIngest(m.message) || m.message
    const messageType = getContentType(content) || 'unknown'
    const me = ownUser(sock)
    const rawSender = m.key.fromMe
        ? me?.id || me?.lid
        : (m.key.participant || m.participant)

    const senderId = isPersonJid(rawSender) ? jidNormalizedUser(rawSender) : ''
    const altSender = isPersonJid(m.key.participantAlt)
        ? jidNormalizedUser(m.key.participantAlt)
        : undefined
    const senderName =
        (await cachedSenderName(senderId, altSender, m.key.fromMe ? me?.lid : undefined)) ||
        usableDisplayName(m.pushName) ||
        (m.key.fromMe ? usableDisplayName(me?.name) : '') ||
        nameFromGroup(groupMetadata, senderId, altSender) ||
        ''
    if (senderName) {
        const nameEntries = (await linkedJids(senderId, altSender)).map((personJid) => ({
            jid: personJid,
            name: senderName,
        }))
        await setSenderDisplayNames(nameEntries)
    }
    const timestamp = unixSeconds(m.messageTimestamp)
    if (isHistory && timestamp < historyCutoffSeconds()) return 'ignored'
    const ingestLog = isHistory ? log.debug.bind(log) : log.info.bind(log)
    const messageSecret = extractMessageSecret(m.message)
    const alreadyEdited = isEditedWrapper(m.message)
    const isForwarded = isForwardedContent(content)

    if (
        messageType === 'protocolMessage' ||
        messageType === 'pinInChatMessage' ||
        messageType === 'unknown'
    ) {
        return 'ignored'
    }
    if (isLivePhotoMotionVideo(m.message, content)) {
        ingestLog(
            { messageId, groupJid: jid, groupName, isHistory },
            'media.live_photo_video_skipped'
        )
        return 'ignored'
    }
    if (messageId) {
        const existing = await getMessageMediaState(messageId)
        if (existing) {
            await rememberMessageSecret(messageId, messageSecret)
            const association = albumAssociationOf(m.message, content)
            if (association.parentId) {
                // Native WhatsApp MEDIA_ALBUM association — trust parentMessageKey as-is.
                await updateAlbumLink(messageId, association.parentId, association.index)
            } else if (isAlbumMediaType(messageType) && isHistory) {
                // History sync often strips messageAssociation; fall back to nearby attach.
                const albumParentId = await resolveAlbumParent({
                    groupJid: jid,
                    senderJid: senderId || null,
                    timestamp,
                    messageType,
                    explicitParentId: null,
                    isHistory,
                })
                if (albumParentId) {
                    await updateAlbumLink(messageId, albumParentId, null)
                }
            }
            if (messageType === 'albumMessage') {
                const expected = albumExpectedOf(m.message, content)
                await updateAlbumExpected(messageId, expected.images, expected.videos)
                if (isHistory) {
                    try {
                        await attachNearbyAlbumMedia({
                            parentId: messageId,
                            groupJid: jid,
                            senderJid: senderId || null,
                            timestamp,
                            expectedImages: expected.images,
                            expectedVideos: expected.videos,
                        })
                    } catch (err) {
                        log.warn(
                            { err, messageId, groupJid: jid, senderJid: senderId },
                            'album.nearby_attach_failed'
                        )
                    }
                }
            }
            if (isForwarded) await markMessageForwarded(messageId)
            if (alreadyEdited) {
                const editedText = textFromMessage(m.message)
                if (editedText != null) {
                    const result = await applyPlaintextEdit(messageId, editedText, {
                        groupJid: jid,
                        isHistory,
                    })
                    if (result === 'applied') return 'edited'
                }
            }
            // Message already saved, but media may still be missing after a disconnect mid-download.
            const needsMedia = Boolean(fileTypes[messageType])
            if (
                needsMedia &&
                !config.skipMediaDownload &&
                !existing.mediaPath &&
                !existing.isDeleted
            ) {
                const mediaMeta = {
                    messageId,
                    groupJid: jid,
                    groupName,
                    messageType,
                    timestamp,
                    isHistory,
                    senderName,
                    albumIndex: association.index ?? null,
                }
                ingestLog(
                    { messageId, groupJid: jid, groupName, messageType, isHistory },
                    'media.retry_missing'
                )
                if (isHistory) void storeMediaFile(m, sock, mediaMeta)
                else await storeMediaFile(m, sock, mediaMeta)
            }
            if (messageType !== 'reactionMessage') return 'ignored'
        }
    }

    const reaction = content.reactionMessage
    if (reaction) {
        const targetMessageId = reaction.key?.id
        if (!targetMessageId) return 'ignored'

        const emoji = reaction.text?.trim() || ''
        const reactedAt = secondsFromMillis(reaction.senderTimestampMs, timestamp)
        try {
            if (!senderId) return 'ignored'
            await upsertGroup(jid, groupName, true)
            await rememberMessageSender(senderId, altSender, senderName)
            if (emoji) {
                await upsertReaction({
                    targetMessageId,
                    groupJid: jid,
                    senderJid: senderId,
                    emoji,
                    timestamp: reactedAt,
                    isHistory,
                })
                ingestLog(
                    {
                        messageId,
                        targetMessageId,
                        groupJid: jid,
                        groupName,
                        senderJid: senderId,
                        emoji,
                        isHistory,
                    },
                    'reaction.saved'
                )
            } else {
                await removeReaction(targetMessageId, senderId, reactedAt)
                ingestLog(
                    {
                        messageId,
                        targetMessageId,
                        groupJid: jid,
                        senderJid: senderId,
                        isHistory,
                    },
                    'reaction.removed'
                )
            }
            return 'reaction'
        } catch (err) {
            log.error(
                {
                    err,
                    messageId,
                    targetMessageId,
                    groupJid: jid,
                    senderJid: senderId,
                },
                'reaction.save_failed'
            )
            return 'error'
        }
    }

    const textContent = textFromMessage(content)
    const ctx = contextInfoOf(content)
    const replyToId = ctx?.stanzaId || content.extendedTextMessage?.contextInfo?.stanzaId || null
    const quotedRaw = ctx?.quotedMessage
    const quotedContent = quotedRaw ? contentForIngest(quotedRaw) || quotedRaw : null
    const quotedMessage =
        textFromMessage(quotedContent) ||
        quotedContent?.documentMessage?.fileName ||
        quotedContent?.documentMessage?.title ||
        content.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
        content.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage?.caption ||
        null

    const association = albumAssociationOf(m.message, content)
    const expected = albumExpectedOf(content, m.message)
    let albumParentId = association.parentId
    let albumIndex = association.index
    if (!albumParentId && isAlbumMediaType(messageType) && isHistory) {
        // History sync often strips messageAssociation; fall back to nearby attach.
        albumParentId = await resolveAlbumParent({
            groupJid: jid,
            senderJid: senderId || null,
            timestamp,
            messageType,
            explicitParentId: null,
            isHistory,
        })
        if (!albumParentId) albumIndex = null
    }
    if (albumParentId && albumIndex == null && isAlbumMediaType(messageType)) {
        albumIndex = await nextAlbumIndex(albumParentId)
    }

    if (!messageId) return 'ignored'

    try {
        await upsertGroup(jid, groupName, true)
        if (senderId) await rememberMessageSender(senderId, altSender, senderName)
        const mentioned = mentionedJidsOf(content)
        if (mentioned.length > 0) {
            await upsertSenders(
                await Promise.all(
                    mentioned.map(async (personJid) => ({
                        jid: personJid,
                        displayName:
                            (await cachedSenderName(personJid)) ||
                            nameFromGroup(groupMetadata, personJid) ||
                            '',
                    }))
                )
            )
        }
        await insertMessage({
            messageId,
            groupJid: jid,
            senderJid: senderId || null,
            messageSecret,
            messageType,
            textContent,
            mediaPath: null,
            fileName:
                messageType === 'documentMessage'
                    ? originalMediaName(content, fileTypes.documentMessage || 'pdf')
                    : null,
            replyToId,
            quotedMessage,
            albumParentId,
            albumIndex,
            albumExpectedImages: expected.images,
            albumExpectedVideos: expected.videos,
            timestamp,
            isEdited: alreadyEdited,
            isHistory,
            isForwarded,
        })
        if (messageId) await flushPendingEdits(messageId)
        if (messageType === 'albumMessage' && isHistory) {
            try {
                await attachNearbyAlbumMedia({
                    parentId: messageId,
                    groupJid: jid,
                    senderJid: senderId || null,
                    timestamp,
                    expectedImages: expected.images,
                    expectedVideos: expected.videos,
                })
            } catch (err) {
                log.warn(
                    { err, messageId, groupJid: jid, senderJid: senderId },
                    'album.nearby_attach_failed'
                )
            }
        }
        const hasMedia = Boolean(fileTypes[messageType])
        if (hasMedia && !config.skipMediaDownload) {
            const mediaMeta = {
                messageId,
                groupJid: jid,
                groupName,
                messageType,
                timestamp,
                isHistory,
                senderName,
                albumIndex: albumIndex ?? null,
            }
            if (isHistory) void storeMediaFile(m, sock, mediaMeta)
            else await storeMediaFile(m, sock, mediaMeta)
        }
        ingestLog(
            {
                messageId,
                groupJid: jid,
                groupName,
                senderJid: senderId,
                senderName,
                messageType,
                hasMedia,
                mediaSkipped: hasMedia && config.skipMediaDownload,
                albumParentId,
                albumIndex,
                albumAssociation: Boolean(association.parentId),
                ...(messageType === 'albumMessage'
                    ? {
                          albumExpectedImages: expected.images,
                          albumExpectedVideos: expected.videos,
                      }
                    : {}),
                isHistory,
                isForwarded,
            },
            'message.ingested'
        )
        void enqueueMessageEvent({
            event: 'message.created',
            messageId,
            groupJid: jid,
            messageType,
            mediaPath: null,
            isHistory,
        })
        return 'saved'
    } catch (err) {
        log.error(
            { err, messageId, groupJid: jid, senderJid: senderId, messageType },
            'message.insert_failed'
        )
        return 'error'
    }
}
