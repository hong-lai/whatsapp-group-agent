import { redis } from '../redis.js'

export const MEDIA_SCAN_CHANNEL = 'media.scan'

/** Ask ingest to walk missing files again, including ones whose retries already finished. */
export async function publishMediaScan(): Promise<void> {
    await redis.publish(MEDIA_SCAN_CHANNEL, '1')
}
