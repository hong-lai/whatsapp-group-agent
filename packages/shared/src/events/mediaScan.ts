import { redis } from '../redis.js'

export const MEDIA_SCAN_CHANNEL = 'media.scan'

/** Ask ingest to walk missing media the same way a process start does. */
export async function publishMediaScan(): Promise<void> {
    await redis.publish(MEDIA_SCAN_CHANNEL, '1')
}
