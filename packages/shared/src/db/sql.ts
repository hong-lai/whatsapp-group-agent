/** Protocol-ish rows that should not surface in the web chat UI. */
export const DASHBOARD_HIDDEN_MESSAGE_TYPES = ['pinInChatMessage', 'unknown'] as const
export const DASHBOARD_HIDDEN_TYPES_SQL = `m.message_type <> ALL(ARRAY[${DASHBOARD_HIDDEN_MESSAGE_TYPES.map(
    (type) => `'${type}'`
).join(', ')}]::text[])`

export const FILE_NAME_SQL = `COALESCE(
                NULLIF(BTRIM(m.file_name), ''),
                regexp_replace(m.media_path, '^.*[\\\\/]', '')
            )`

export const FILE_NAME_SQL_BARE = `COALESCE(
                NULLIF(BTRIM(file_name), ''),
                regexp_replace(media_path, '^.*[\\\\/]', '')
            )`

export function likeContainsPattern(query: string): string {
    return `%${query.replace(/[\\%_]/g, '\\$&')}%`
}
