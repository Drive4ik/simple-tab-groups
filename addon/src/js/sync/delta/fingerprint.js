
import {LOCK_FILE_NAME} from './layout.js';

function hashString(str, seed) {
    let hash = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16);
}

function fileMarker(file) {
    const content = typeof file?.content === 'string' ? file.content : '';
    const contentHash = `${hashString(content, 0x811c9dc5)}.${hashString(content, 0x0badf00d)}.${content.length}`;

    if (file?.truncated) {
        return `t:${file.size}:${file.raw_url}:${contentHash}`;
    }

    return contentHash;
}

export function contentFingerprint(files) {
    return Object.entries(files ?? {})
        .filter(([name]) => name !== LOCK_FILE_NAME)
        .map(([name, file]) => `${name}=${fileMarker(file)}`)
        .sort()
        .join('|');
}
