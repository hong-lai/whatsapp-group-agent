import makeWASocket, {
    aesDecryptGCM,
    Browsers,
    DisconnectReason,
    downloadMediaMessage,
    getContentType,
    type GroupMetadata,
    hmacSign,
    isJidGroup,
    jidDecode,
    jidNormalizedUser,
    proto,
    useMultiFileAuthState,
    type WAMessage,
    WAProto
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import NodeCache from '@cacheable/node-cache'
import { createWriteStream, existsSync, mkdirSync } from 'fs'
import logger from '@whiskeysockets/baileys/lib/Utils/logger.js'
import pino from 'pino'
import sqlite3 from 'sqlite3'
import { open, Database } from 'sqlite'

const groupCache = new NodeCache<GroupMetadata>({ stdTTL: 0, useClones: false })
// const contactNameStore = new Map<string, string>();
const testGroupPattern = /富山邨|錦田/i

const fileTypes: Record<string, string> = {
    'imageMessage': 'jpeg',
    'videoMessage': 'mp4',
    'stickerMessage': 'webp',
    'documentMessage': 'pdf',
    'audioMessage': 'ogg'
}

let db: Database;

// 🗄️ Initialize SQLite Database
async function initDB() {
    db = await open({
        filename: './whatsapp_messages.db',
        driver: sqlite3.Database
    })

    await db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            message_id TEXT PRIMARY KEY,
            message_secret TEXT,
            group_jid TEXT,
            group_name TEXT,
            sender_id TEXT,
            sender_name TEXT,
            message_type TEXT,
            text_content TEXT,
            media_path TEXT,
            reply_to_id TEXT,
            quoted_message TEXT,
            timestamp INTEGER,
            is_edited BOOLEAN,
            is_deleted BOOLEAN,
            is_history BOOLEAN
        )
    `)
    console.log('✅ SQLite Database initialized')
}

const decryptEditedMessage = ({ encPayload, encIv }, { secret, id, sender }) => {
    const toBinary = (txt: string) => Buffer.from(txt)
    const senderBuf = toBinary(sender)
    const sign = Buffer.concat([
        toBinary(id),
        senderBuf,
        senderBuf,
        toBinary('Message Edit'),
        new Uint8Array([1])
    ])
    const key = hmacSign(secret, new Uint8Array(32))
    const decKey = hmacSign(sign, key)
    const decrypted = aesDecryptGCM(encPayload, decKey, encIv, '')
    return proto.Message.decode(decrypted)
}

// 🛠️ Process and download media/messages from matched groups
async function processMessage(m: WAMessage, sock: any, isHistory = false) {
    if (!m.message || !m.key.remoteJid) return

    const jid = m.key.remoteJid
    if (!isJidGroup(jid)) return // Skip Direct Messages

    // Fetch/Verify group metadata
    let groupMetadata = groupCache.get(jid)
    if (!groupMetadata) {
        // try {
        //     groupMetadata = await sock.groupMetadata(jid)
        //     if (groupMetadata) groupCache.set(jid, groupMetadata)
        // } catch {
        //     return
        // }
        return
    }

    const groupName = groupMetadata.subject
    // Filter out groups that don't match the pattern
    if (!testGroupPattern.test(groupName)) return

    const messageId = m.key.id
    const messageType = getContentType(m.message) || 'unknown'
    const rawSender = m.key.fromMe
        ? (sock.user?.id || sock.user?.jid)
        : (m.key.participant || m.participant)

    const senderId = rawSender ? jidNormalizedUser(rawSender) : jid
    const senderName = m.pushName || jidDecode(senderId)?.user || ''
    const timestamp = Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)
    // const replyMessageId = m.key.

    if (messageType === 'protocolMessage') return

    console.log(`\n--- [${isHistory ? 'HISTORY' : 'LIVE'}] ${groupName} ---`)
    console.log('ID:        ', messageId)
    console.log('Sender ID:    ', senderId)
    console.log('Push Name: ', senderName)
    console.log('Type:      ', messageType)
    console.log('Date:      ', new Date(timestamp * 1000).toLocaleString())

    // 1. Extract Text Content
    const textContent =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        m.message?.videoMessage?.caption ||
        null

    const replyToId = m.message?.extendedTextMessage?.contextInfo?.stanzaId || null
    const quotedMessage = m.message.extendedTextMessage?.contextInfo?.quotedMessage?.conversation || m.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage?.caption || null

    const reactionMessage = m.message.reactionMessage?.text
    console.log(reactionMessage) // create a reaction table for storing this information.
    let messageSecret = m.message.messageContextInfo?.messageSecret ?? null
    if (messageSecret) {
        messageSecret = JSON.stringify(Array.from(messageSecret))
    }

    if (textContent) {
        console.log(`💬 Text: ${textContent}`)
    }

    let mediaPath: string | null = null;

    // 2. Process Media Downloads
    if (messageType && fileTypes[messageType]) {
        try {
            const stream = await downloadMediaMessage(
                m,
                'stream',
                {},
                {
                    logger,
                    reuploadRequest: sock.updateMediaMessage
                }
            )
            const hktDate = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Asia/Hong_Kong',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            }).format(timestamp * 1000);

            const safeFolderName = groupName.replace(/[/\\?%*:|"<>]/g, '_')
            const folderPath = `./downloads/${safeFolderName}/${hktDate}`

            if (!existsSync(folderPath)) {
                mkdirSync(folderPath, { recursive: true })
            }

            const fileName = `${folderPath}/${timestamp}_${messageId}.${fileTypes[messageType]}`

            const writeStream = createWriteStream(fileName)
            stream.pipe(writeStream)

            mediaPath = fileName;
            console.log(`📁 Media saved to: ${fileName}`)
        } catch (err) {
            console.error('❌ Error downloading media:', err)
        }
    }

    // 3. Save to SQLite Database
    if (messageId) {
        try {
            await db.run(
                `INSERT OR IGNORE INTO messages 
                (message_id, message_secret, group_jid, group_name, sender_id, sender_name, message_type, text_content, media_path, reply_to_id, quoted_message, timestamp, is_edited, is_deleted, is_history) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [messageId, messageSecret, jid, groupName, senderId, senderName, messageType, textContent, mediaPath, replyToId, quotedMessage, timestamp, 0, 0, isHistory]
            )
            console.log(`💾 Message ${messageId} saved to DB.`)
        } catch (err) {
            console.error(`❌ DB Insert Error for ${messageId}:`, err)
        }
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        cachedGroupMetadata: async (jid) => groupCache.get(jid),
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true,
    })

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) qrcode.generate(qr, { small: true })

        if (connection === 'close') {
            const shouldReconnect =
                (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('Connection closed, reconnecting:', shouldReconnect)
            if (shouldReconnect) connectToWhatsApp()
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp')

            // Populate cache for all participating groups <<-- is this necessary?
            const response = await sock.groupFetchAllParticipating()
            for (const key in response) {
                if (response[key] && testGroupPattern.test(response[key].subject)) {
                    groupCache.set(key, response[key])
                }
            }
            console.log(`📦 Pre-cached ${groupCache.keys().length} matching groups`)
        }
    })

    // 📩 Process historical messages on connect
    sock.ev.on('messaging-history.set', async ({ messages, contacts, syncType }) => {
        console.log(`📥 Processing history sync (Type: ${syncType}, Items: ${messages?.length || 0})`)

        for (const c of contacts) {
            console.log(c)
        }
        for (const m of messages) {
            await processMessage(m, sock, true)
        }
    })

    const MessageEditEncType = proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT

    // ⚡ Real-time messages
    sock.ev.on('messages.upsert', async (event) => {
        if (event.type == 'notify') {
            console.log("Total messages:", event.messages.length)
            for (const m of event.messages) {
                const secEncMsg = m.message?.secretEncryptedMessage
                if (secEncMsg?.secretEncType === MessageEditEncType) {
                    const targetMsgId = secEncMsg.targetMessageKey?.id
                    const response = await db.get('select message_secret from messages where message_id=?', [targetMsgId])
                    if (response) {
                        const msgSec = new Uint8Array(JSON.parse(response.message_secret))
                        try {
                            const decryptedMessage: WAProto.IMessage = decryptEditedMessage(secEncMsg, { secret: msgSec, id: targetMsgId, sender: m.key.participant || m.participant || m.key.remoteJid })
                            console.log(decryptedMessage)
                            const editedMessage = decryptedMessage.protocolMessage?.editedMessage?.conversation ?? decryptedMessage.protocolMessage?.editedMessage?.imageMessage?.caption ?? ''
                            await db.run('update messages set text_content=?, is_edited=? where message_id=?', [editedMessage, 1, targetMsgId])

                        } catch (err) {
                            console.log('❌ Failed to decrypt the edited message.')
                        }
                    }
                } else {
                    await processMessage(m, sock, false)
                }
            }
        }
    })

    sock.ev.on('messages.update', async (updates) => {
        for (const u of updates) {
            // Deletion?? why it is not in the messages.delete event??
            if (u.update.messageStubType === 1) {
                const msgId = u.key.id
                await db.run("update from messages set is_deleted = ? where message_id = ?", [1, msgId])
            }
        }
    })

    sock.ev.on('messages.delete', async (e) => {
        // What is the purpose of this event?? When does this fire?
        console.log('deletion')
    })

    // sock.ev.on('contacts.upsert', (contacts) => {
    //     for (const contact of contacts) {
    //         console.log(contact)
    //         const name = contact.notify || contact.name;
    //         if (name) {
    //             contactNameStore.set(contact.id, name);
    //         }
    //     }
    // });

    sock.ev.on('groups.update', async ([event]) => {
        if (event?.id) {
            const groupMetadata = await sock.groupMetadata(event.id)
            const groupName = groupMetadata?.subject
            if (!groupName || !testGroupPattern.test(groupName)) return
            groupCache.set(groupMetadata.id, groupMetadata)
            console.log('Updated group metadata for', event.id, 'with name', groupName)
        }
    })

    sock.ev.on('group-participants.update', async (event) => {
        const groupMetadata = await sock.groupMetadata(event.id)
        const groupName = groupMetadata?.subject
        if (!groupName || !testGroupPattern.test(groupName)) return
        groupCache.set(groupMetadata.id, groupMetadata)
        console.log('Updated group participants for', event.id, 'with name', groupName)
    })

    sock.ev.on('creds.update', saveCreds)
}

// Boot up sequence
(async () => {
    await initDB();
    await connectToWhatsApp();
})();