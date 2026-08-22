import makeWASocket, { DisconnectReason, downloadMediaMessage, getContentType, type GroupMetadata, isJidGroup, useMultiFileAuthState } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import NodeCache from '@cacheable/node-cache'
import { createWriteStream } from 'fs'
import logger from '@whiskeysockets/baileys/lib/Utils/logger.js'
import fs from 'node:fs'

const groupCache = new NodeCache<GroupMetadata>({ stdTTL: 0, useClones: false })

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')

    const sock = makeWASocket({
        auth: state,
        cachedGroupMetadata: async (jid) => {
            console.log('cached group metadata for', jid)
            return groupCache.get(jid)
        }
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
                        addSpecificGroup(groupMetadata.id, groupMetadata)
                    }
                }
            }
        }
    })

    sock.ev.on('groups.update', async ([event]) => {
        if (event?.id) {
            const groupMetadata = await sock.groupMetadata(event.id)
            groupCache.set(groupMetadata.id, groupMetadata)
            console.log('Updated group metadata for', event.id, 'with name', groupMetadata.subject)
        }
    })

    sock.ev.on('group-participants.update', async (event) => {
        const groupMetadata = await sock.groupMetadata(event.id)
        groupCache.set(groupMetadata.id, groupMetadata)
        console.log('Updated group participants for', event.id)
    })

    sock.ev.on('messages.upsert', async (event) => {
        if (event.type !== 'notify') return
        for (const m of event.messages) {
            if (!m.message) continue
            // if (m.key.fromMe) continue

            // if Jid is int the cache group, then we simply capture it.
            if (m.key.remoteJid && groupCache.has(m.key.remoteJid)) {
                const messageType = getContentType(m.message)
                const groupMetadata = groupCache.get(m.key.remoteJid)
                const groupName = groupMetadata?.subject ?? 'UNNAMED'
                const sender = m.key.participant;
                const timestamp = m.messageTimestamp;


                console.log('GROUP NAME: ', groupName)
                console.log('Sender Id: ', sender)
                console.log('Push Name: ', m.pushName)
                console.log('Message Type: ', messageType)
                console.log('Date: ', new Date(timestamp as number * 1000).toLocaleString())

                // 1. Check for standard text message
                const textContent = m.message?.conversation || m.message?.extendedTextMessage?.text;
                if (textContent) {
                    console.log(`Text from ${sender}: ${textContent}`);
                }

                const fileTypes = {
                    'imageMessage': 'jpeg',
                    'videoMessage': 'mp4',
                    'stickerMessage': 'webp'
                }

                if (messageType == 'imageMessage' || messageType == 'stickerMessage' || messageType == 'videoMessage') {
                    const stream = await downloadMediaMessage(
                        m,
                        'stream',
                        {},
                        {
                            logger,
                            reuploadRequest: sock.updateMediaMessage
                        }
                    );

                    try {
                        if (!fs.existsSync(`groups/${groupName}`)) {
                            fs.mkdirSync(`groups/${groupName}`, { recursive: true });
                        }
                    } catch (err) {
                        console.error(err)
                    }

                    const writeStream = createWriteStream(`groups/${groupName}/image_${Date.now()}.${fileTypes[messageType]}`);
                    stream.pipe(writeStream);
                }

                // 2. Check for image message
                // const imageMessage = m.message?.imageMessage;
                // if (imageMessage) {
                //     console.log(`Image received from ${sender}. Caption: ${imageMessage.caption || 'None'}`);

                //     try {
                //         // Download image as a binary buffer
                //         const buffer = await downloadMediaMessage(
                //             m,
                //             'buffer',
                //             {},
                //             {
                //                 logger: console as any,
                //             }
                //         );

                //         // Save the image locally
                //         const filename = `image_${Date.now()}.jpeg`;
                //         await fs.promises.writeFile(filename, buffer);
                //         console.log(`Saved image to ${filename}`);

                //     } catch (error) {
                //         console.error('Failed to download image:', error);
                //     }
                // }
                // console.log(sender, messageContent)
            }

            // console.log('replying to', m.key.remoteJid)
            // await sock.sendMessage(m.key.remoteJid!, { text: 'Hello from Baileys!' })
        }
    })




    // Save credentials whenever they are updated
    sock.ev.on('creds.update', saveCreds)
}

connectToWhatsApp()


const testGroupPattern = /義合|CLP 報工|Yee Hop/
const testGroupPattern2 = /Supergroup/

function addSpecificGroup(jid: string, groupMetadata: GroupMetadata) {
    const groupName = groupMetadata?.["subject"] ?? 'UNK'
    console.log(`Checking group ${jid} with name ${groupName} against pattern ${testGroupPattern2}`)
    if (testGroupPattern.test(groupName) && groupMetadata?.id) {
        groupCache.set(groupMetadata.id, groupMetadata)
        console.log(`Added group ${jid} with name ${groupName} to cache`)
    }
}

process.on('SIGINT', () => {
    const groups = groupCache.mget(groupCache.keys())

    for (const [key, value] of Object.entries(groups)) {
        console.log(value?.subject ?? 'UNK')
    }

    process.exit(0)
})