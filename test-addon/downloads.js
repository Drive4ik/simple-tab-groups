import {Test} from './test.js';

export const FOLDER = 'stg-behavior-tests';

// the path from the folder of the round on: the user's folders above it never reach a report
export const shownPath = filename => {
    if (!filename) {
        return 'absent';
    }

    const at = filename.lastIndexOf(FOLDER);

    return at === -1 ? `outside ${FOLDER}: ${filename.split(/[\\/]/).pop()}` : filename.slice(at).replaceAll('\\', '/');
};

// an error text without a path
export const scrub = text => String(text).replace(/(?:[A-Za-z]:\\|\/)[^'"\s]*[\\/]/g, '.../');

export const describeItem = item => item
    ? `state ${item.state}, error ${item.error ?? 'none'}, bytes ${item.bytesReceived}/${item.totalBytes}, exists ${item.exists}, file ${shownPath(item.filename)}`
    : 'not found';

export class DownloadsTest extends Test {
    constructor(options) {
        super(options);
        this.created = new Map(); // download id → its label in the test: the id itself is never printed
        this.endedAt = new Map(); // download id → the ms of the onChanged that took its state out of in_progress
        this.onEnded = null; // a test's hook, called with the id at that onChanged, before its line is written
        this.mask = text => text.replaceAll(location.origin, 'moz-extension://<self>');
    }

    label(id) {
        return this.created.get(id) ?? 'foreign';
    }

    // a download event counts against the quiet window, the way tab events do in TabsTest
    onEvent(spec, args, updatedKeys) {
        this.bump();

        if (spec === 'downloads.onChanged' && args[0].state && args[0].state.current !== 'in_progress') {
            this.endedAt.set(args[0].id, this.ms());
            this.onEnded?.(args[0].id);
        }

        super.onEvent(spec, args, updatedKeys);
    }

    // the label is looked up when the report is written: onCreated may come before download() resolves with the id
    eventFormatters() {
        return {
            'downloads.onCreated': ([item]) => () => `${this.label(item.id)}  ${describeItem(item)}`,
            'downloads.onChanged': ([delta]) => () => `${this.label(delta.id)}  ${Object.entries(delta)
                .filter(([key]) => key !== 'id')
                .map(([key, {current}]) => `${key}: ${key === 'filename' ? shownPath(current) : JSON.stringify(current)}`)
                .join(', ')}`,
        };
    }

    // there is no state table for downloads: the action goes into the event log as its own line,
    // so the events that follow are read under the action that caused them
    act(text) {
        super.act(text);
        this.record('action', text, 0);
    }

    async close() {
        for (const id of this.created.keys()) {
            await browser.downloads.cancel(id).catch(() => {});
            await browser.downloads.removeFile(id).catch(() => {});
            await browser.downloads.erase({id}).catch(() => {});
        }

        this.created.clear();
    }
}
