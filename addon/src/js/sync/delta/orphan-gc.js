import {selectOrphanDeltaFilesToDelete} from './compaction.js';

export async function deleteOrphanDeltaFiles(Cloud, pulledDeltaLogs, watermark, selfDeviceId, log = null) {
    if (typeof Cloud?.deleteFile !== 'function') {
        return [];
    }

    const orphans = selectOrphanDeltaFilesToDelete(pulledDeltaLogs, watermark, selfDeviceId);
    const deleted = [];

    for (const name of orphans) {
        try {
            await Cloud.deleteFile(name);
            deleted.push(name);
            log?.info?.('compaction GC: deleted orphan peer delta file fully folded into published snapshot', {name});
        } catch (error) {
            log?.warn?.('compaction GC: cant delete orphan peer delta file; leaving it for a later cycle', {
                name,
                error: String(error),
            });
        }
    }

    return deleted;
}
