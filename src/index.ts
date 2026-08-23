import makeWASocket, {
    Browsers,
    DisconnectReason,
    downloadMediaMessage,
    getContentType,
    type GroupMetadata,
    isJidGroup,
    jidNormalizedUser,
    useMultiFileAuthState,
    type WAMessage
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
const testGroupPattern = /Supergroup/i

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
            group_jid TEXT,
            group_name TEXT,
            sender TEXT,
            push_name TEXT,
            message_type TEXT,
            text_content TEXT,
            media_path TEXT,
            timestamp INTEGER,
            is_history BOOLEAN
        )
    `)
    console.log('✅ SQLite Database initialized')
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

    const sender = rawSender ? jidNormalizedUser(rawSender) : jid
    const pushName = m.pushName || ''
    const timestamp = Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)

    if (messageType === 'protocolMessage') return

    console.log(`\n--- [${isHistory ? 'HISTORY' : 'LIVE'}] ${groupName} ---`)
    console.log('ID:        ', messageId)
    console.log('Sender:    ', sender)
    console.log('Push Name: ', pushName)
    console.log('Type:      ', messageType)
    console.log('Date:      ', new Date(timestamp * 1000).toLocaleString())

    // 1. Extract Text Content
    const textContent =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        m.message?.videoMessage?.caption ||
        null

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

            const safeFolderName = groupName.replace(/[/\\?%*:|"<>]/g, '_')
            const folderPath = `./downloads/${safeFolderName}`

            if (!existsSync(folderPath)) {
                mkdirSync(folderPath, { recursive: true })
            }

            const fileName = `${folderPath}/${Date.now()}_${messageId}.${fileTypes[messageType]}`
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
                (message_id, group_jid, group_name, sender, push_name, message_type, text_content, media_path, timestamp, is_history) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [messageId, jid, groupName, sender, pushName, messageType, textContent, mediaPath, timestamp, isHistory]
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

            // Populate cache for all participating groups
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
    sock.ev.on('messaging-history.set', async ({ messages, syncType }) => {
        console.log(`📥 Processing history sync (Type: ${syncType}, Items: ${messages?.length || 0})`)
        for (const m of messages) {
            await processMessage(m, sock, true)
        }
    })

    // ⚡ Real-time messages
    sock.ev.on('messages.upsert', async (event) => {
        if (event.type !== 'notify') return
        for (const m of event.messages) {
            await processMessage(m, sock, false)
        }
    })

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