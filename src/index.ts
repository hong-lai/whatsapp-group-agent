import makeWASocket, { DisconnectReason, type GroupMetadata, isJidGroup, useMultiFileAuthState } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import NodeCache from '@cacheable/node-cache'

const groupCache = new NodeCache<GroupMetadata>({ stdTTL: 0, useClones: false })

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')

    const sock = makeWASocket({
        auth: state,
        cachedGroupMetadata: async (jid) => groupCache.get(jid)
    })

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) {
            qrcode.generate(qr, { small: true })
        }
        if (connection === 'close') {
            const shouldReconnect =
                (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('connection closed due to', lastDisconnect?.error, ', reconnecting:', shouldReconnect)
            if (shouldReconnect) {
                connectToWhatsApp()
            }
        } else if (connection === 'open') {
            console.log('opened connection')

            const response = await sock.groupFetchAllParticipating()
            for (const key in response) {
                if (isJidGroup(key)) {
                    const groupMetadata = response[key];
                    if (groupMetadata) {
                        addSpecificGroup(groupMetadata)
                    }
                }
            }
        }
    })

    sock.ev.on('groups.update', async ([event]) => {
        if (event?.id) {
            const groupMetadata = await sock.groupMetadata(event.id)
            groupCache.set(event.id, groupMetadata)
        }
    })

    sock.ev.on('group-participants.update', async (event) => {
        const groupMetadata = await sock.groupMetadata(event.id)
        groupCache.set(event.id, groupMetadata)
    })

    sock.ev.on('messages.upsert', async (event) => {
        if (event.type !== 'notify') return
        for (const m of event.messages) {
            // if (m.key.fromMe) continue
            console.log(JSON.stringify(m, undefined, 2))


            // console.log('replying to', m.key.remoteJid)
            // await sock.sendMessage(m.key.remoteJid!, { text: 'Hello from Baileys!' })
        }
    })




    // Save credentials whenever they are updated
    sock.ev.on('creds.update', saveCreds)
}

connectToWhatsApp()


function addSpecificGroup(groupMetadata: GroupMetadata) {
    const groupName = groupMetadata?.["subject"] ?? 'UNK'
    if (/義合|CLP 報工|Yee Hop/.test(groupName) && groupMetadata?.id) {
        groupCache.set(groupMetadata.id, groupMetadata)
    }
}

process.on('SIGINT', () => {
    const groups = groupCache.mget(groupCache.keys())

    for (const [key, value] of Object.entries(groups)) {
        console.log(value?.subject ?? 'UNK')
    }

    process.exit(0)
})