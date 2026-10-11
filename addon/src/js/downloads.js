import Listeners from './listeners.js?downloads.onChanged';

export const {State, InterruptReason, FilenameConflictAction} = browser.downloads;

const ending = new Map(); // id → {resolve, state, error}: the downloads a caller waits for

// the end of a download is its state, not the bytes (BEHAVIOR-DOWNLOADS.md §2); the reason of an interruption comes
// in the same delta (§7) or in the next one (§4): an interrupted download is done once the reason is known
const isEnded = ({state, error}) => state === State.COMPLETE || (state === State.INTERRUPTED && !!error);

// one handler for the module: add() replays the last delta that came without a listener
Listeners.downloads.onChanged.add(({id, state, error}) => {
    const download = ending.get(id);

    if (!download) {
        return;
    }

    download.state = state?.current ?? download.state;
    download.error = error?.current ?? download.error;

    if (isEnded(download)) {
        download.resolve();
    }
});

// the download of the blob with the options of downloads.download(), from its start to its end: the DownloadItem
export async function download(blob, options) {
    const url = URL.createObjectURL(blob);

    try {
        const id = await browser.downloads.download({...options, url});
        const {promise, resolve} = Promise.withResolvers();

        ending.set(id, {resolve, state: null, error: null}); // right at the resolve, nothing awaited in between: the end comes after it (§1)

        try {
            let [item] = await browser.downloads.search({id});

            if (!isEnded(item)) {
                await promise;
                [item] = await browser.downloads.search({id});
            }

            return item;
        } finally {
            ending.delete(id);
        }
    } finally {
        URL.revokeObjectURL(url);
    }
}

// the user's Cancel in the Save As dialog: download() rejects before any item exists (BEHAVIOR-DOWNLOADS.md §6)
export function isCanceledByUser(error) {
    return error.message.startsWith('Download canceled');
}

export function eraseId(id) {
    return browser.downloads.erase({id});
}

export function removeFile(id) {
    return browser.downloads.removeFile(id);
}

export function show(id) {
    return browser.downloads.show(id);
}
