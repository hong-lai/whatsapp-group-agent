import { Redis } from 'ioredis'
import { config } from './config.js'

export const redis = new Redis(config.redisUrl)

export function createRedisSubscriber(): Redis {
    return new Redis(config.redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    })
}
