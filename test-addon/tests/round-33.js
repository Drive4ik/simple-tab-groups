import {TIGHT_POLL_WAIT, SETTLE_TIMEOUT} from '../constants.js';
import {wait} from '../test.js';
import {DownloadsTest, FOLDER, describeItem, scrub} from '../downloads.js';

export const note = `Round 33 - browser.downloads the way the add-on saves a backup: downloads.download from an
object url of a Blob, saveAs: false, conflictAction overwrite, into a folder of its own. What the
resolve of download() brings and what downloads.search({id}) says right at it; which
downloads.onCreated / onChanged events come, in which order against the resolve and when; how long
until the state leaves in_progress, read every TIGHT_POLL_WAIT - the facts behind File.waitDownload
(file.js), which polls downloads.search. A small file (R33.01), a large one (R33.02), both started at
once (R33.03), and the shapes a file name takes in the add-on (R33.04): what a localized date puts
into it - a narrow no-break space, Cyrillic, a trailing dot - and what the user types into the
path - a colon, a question mark, a pipe and an asterisk, a sub-folder, a parent reference (the
add-on cleans the date variables of such characters, not the typed path); which download()
refuses and with what error, which resolves and then ends in what state. The large file canceled
right after the resolve (R33.05): which onChanged announces the interruption, are state and error
in one delta or in two, what search says right at the state delta and at the end - the interrupted
branch of File.save. The object url of the large file revoked right after the resolve, while the
download is in progress (R33.06): does the download still complete, or does it end interrupted and
with what error - the shape File.save had from 2018 to 2020, where the url was revoked once a 5 s
wait ran out (issue #374). R33.07 is MANUAL: saveAs: true, the Save As dialog answered by the user -
canceled first, then saved: is the cancel a rejection of download() and with what text, or a
download that ends interrupted; and the events of the saved one against the resolve. A download
that fails on its own, from an https host no server answers for (R33.08): does download() resolve
or reject, which onChanged announce the failure, state and error in one delta or in two, what
search says right at the state delta - the failed branch of File.save without a user. The
expectations are the facts of BEHAVIOR-DOWNLOADS.md 1-7; the file-name ones hold for Windows, the
error of R33.08 for a machine whose resolver answers "no such host". Every file lands in the folder
${FOLDER} of the downloads directory,
the one the user saves by hand in R33.07 wherever the dialog puts it, and all are removed by their
id with downloads.removeFile and downloads.erase when the test ends; the folder itself and an empty
sub-folder a shape made stay. The report shows the path from ${FOLDER} on, never the folders above
it, and an error text without a path. Needs the downloads permission.`;

export const testClass = DownloadsTest;

const SPECS = ['downloads.onCreated', 'downloads.onChanged'];

const SMALL_BYTES = 1024;
const LARGE_BYTES = 64 * 1024 * 1024;

const NARROW_NO_BREAK_SPACE = String.fromCharCode(0x202F);

// a reserved top-level domain (RFC 6761), no server ever answers for it
const UNREACHABLE_URL = 'https://unreachable.invalid/unreachable.bin';

// the outcome of every shape on Windows (BEHAVIOR-DOWNLOADS.md §3): what download() rejects with, or complete
const ILLEGAL = 'filename must not contain illegal characters';
const BACK_REFERENCE = 'filename must not contain back-references (..)';
const COMPLETE = 'complete';

const SHAPES = [
    ['a narrow no-break space (U+202F), the way a localized time puts it before AM', `STG-backup 10-31${NARROW_NO_BREAK_SPACE}AM.json`, ILLEGAL],
    ['Cyrillic, a localized date', 'STG-бэкап 11.10.2026.json', COMPLETE],
    ['a trailing dot, a localized date at the end of the name', 'STG-backup 11.', ILLEGAL],
    ['a space before the extension', 'STG-backup .json', COMPLETE],
    ['a colon, typed into the path', 'STG 10:31.json', ILLEGAL],
    ['a question mark, typed', 'STG?.json', ILLEGAL],
    ['a pipe and an asterisk, typed', 'STG|*.json', ILLEGAL],
    ['a sub-folder, typed', 'sub/STG-backup.json', COMPLETE],
    ['a sub-folder with a trailing space, typed', 'sub /STG-backup.json', ILLEGAL],
    ['a parent reference, typed', '../STG-backup.json', BACK_REFERENCE],
];

const jsonBlob = bytes => new Blob([JSON.stringify({test: 'x'.repeat(bytes)})], {type: 'application/json'});
const binaryBlob = bytes => new Blob([new Uint8Array(bytes)], {type: 'application/octet-stream'});

// every download starts at once; the resolve of each is recorded the moment it comes, then all of
// them are followed by downloads.search until the state leaves in_progress; an entry's afterResolve
// runs once the search at the resolve is recorded, with the id and the url - a cancel, for the
// interrupted end, or the revoke of the url; saveAs is false unless the entry says otherwise; an
// entry downloads its blob through an object url, or a url of its own when it names one
async function download(t, entries) {
    const urls = entries.map(({blob, url = null}) => url ?? URL.createObjectURL(blob));

    t.act(entries.map(({label, filename, saveAs = false, url = null}) => `downloads.download({${url ? `url: ${url}, ` : ''}filename: ${FOLDER}/${JSON.stringify(filename)}, saveAs: ${saveAs}, conflictAction: overwrite})  // ${label}`).join('; '));

    const started = await Promise.all(entries.map(async ({label, filename, saveAs = false, afterResolve = null}, index) => {
        let id;

        try {
            id = await browser.downloads.download({
                url: urls[index],
                filename: `${FOLDER}/${filename}`,
                saveAs,
                conflictAction: 'overwrite',
            });
        } catch (error) {
            const text = scrub(error.message);

            t.record('download() rejected', `${label}: ${text}`);

            return {label, id: null, error: text};
        }

        const at = t.ms();
        const endedBeforeResolve = t.endedAt.has(id); // read before any await: an end event delivered before the resolve has already run

        t.created.set(id, label);
        t.record('download() resolved', label, at);

        const [item] = await browser.downloads.search({id});
        const seen = describeItem(item);

        t.record('search at the resolve', `${label}: ${seen}`);

        await afterResolve?.(id, urls[index]);

        return {label, id, resolvedAt: at, endedBeforeResolve, seen, final: null};
    }));

    const pending = new Map(started.filter(({id}) => id !== null).map(entry => [entry.id, {entry, last: entry.seen}]));
    const from = Date.now();

    while (pending.size && Date.now() - from < SETTLE_TIMEOUT) {
        for (const [id, track] of pending) {
            const [item] = await browser.downloads.search({id});
            const text = describeItem(item);

            if (text !== track.last) {
                t.record('search', `${track.entry.label}: ${text}`);
                track.last = text;
            }

            if (item?.state !== 'in_progress') {
                track.entry.final = item;
                pending.delete(id);
            }
        }

        await wait(TIGHT_POLL_WAIT);
    }

    for (const {entry} of pending.values()) {
        [entry.final] = await browser.downloads.search({id: entry.id});
        t.note(`${entry.label}: still in_progress after ${SETTLE_TIMEOUT} ms`);
    }

    await t.settled();

    for (const url of urls) {
        if (url.startsWith('blob:')) {
            URL.revokeObjectURL(url);
        }
    }

    for (const entry of started) {
        if (entry.id !== null) {
            entry.endedAt = t.endedAt.get(entry.id) ?? null;
        }

        t.note(`${entry.label}: ${entry.id === null
            ? `download() rejected - ${entry.error}`
            : `resolved at ${entry.resolvedAt} ms, the end event at ${entry.endedAt ?? 'none'} ms${entry.endedBeforeResolve ? ' (before the resolve)' : ''}, final: ${describeItem(entry.final)}`}`);
    }

    return started;
}

// BEHAVIOR-DOWNLOADS.md §1: the item is found at the resolve, the end event comes after the resolve, complete and existing at the end
function expectCompleted(t, entry) {
    t.expect(`${entry.label}: search right at the resolve finds the item (BEHAVIOR-DOWNLOADS.md §1)`, entry.seen !== 'not found', true);
    t.expect(`${entry.label}: the end is announced by onChanged after the resolve (§1)`, [entry.endedAt !== null, entry.endedBeforeResolve], [true, false]);
    t.expect(`${entry.label}: complete and existing at the end (§1)`, [entry.final?.state, entry.final?.exists], [COMPLETE, true]);
}

async function platform(t) {
    const {os} = await browser.runtime.getPlatformInfo();
    const {name, version} = await browser.runtime.getBrowserInfo();

    t.note(`platform: ${os}, ${name} ${version}`);
}

export const tests = [

{
    id: 'R33.01',
    title: 'a small json file, saveAs: false - the resolve of download(), the state at it, the events and the search samples until the download ends',
    async run(t) {
        await platform(t);
        t.watch(SPECS);

        const [entry] = await download(t, [{label: 'small', filename: 'small.json', blob: jsonBlob(SMALL_BYTES)}]);

        expectCompleted(t, entry);
    },
},

{
    id: 'R33.02',
    title: `a large file, ${LARGE_BYTES / 1024 / 1024} MiB - the same, with a download that takes time`,
    async run(t) {
        await platform(t);
        t.watch(SPECS);

        const [entry] = await download(t, [{label: 'large', filename: 'large.bin', blob: binaryBlob(LARGE_BYTES)}]);

        expectCompleted(t, entry);
    },
},

{
    id: 'R33.03',
    title: 'a small and a large file started at once - the resolves and the events of two downloads side by side',
    async run(t) {
        await platform(t);
        t.watch(SPECS);

        const entries = await download(t, [
            {label: 'small', filename: 'small.json', blob: jsonBlob(SMALL_BYTES)},
            {label: 'large', filename: 'large.bin', blob: binaryBlob(LARGE_BYTES)},
        ]);

        for (const entry of entries) {
            expectCompleted(t, entry);
        }

        t.expect('two ids, each with its own completion (§1)', entries.map(entry => entry.id).every((id, index, ids) => id !== null && ids.indexOf(id) === index), true);
    },
},

{
    id: 'R33.04',
    title: 'the shapes a file name takes in the add-on, from a localized date and from the typed path - which download() refuses, with what error, and which ends in what state (Windows)',
    async run(t) {
        await platform(t);
        t.watch(SPECS);

        const outcomes = {};
        const expected = {};

        for (const [label, filename, outcome] of SHAPES) {
            const [entry] = await download(t, [{label, filename, blob: jsonBlob(SMALL_BYTES)}]);

            outcomes[label] = entry.id === null ? entry.error : entry.final?.state;
            expected[label] = outcome;
        }

        t.expect('the outcome of every shape (BEHAVIOR-DOWNLOADS.md §3, Windows)', outcomes, expected);
    },
},

{
    id: 'R33.05',
    title: 'the large file canceled right after the resolve - which onChanged announces the interruption, are state and error in one delta or in two, what search says right at the state delta and at the end: the interrupted branch of File.save',
    async run(t) {
        await platform(t);
        t.watch(SPECS);

        // is the reason there already when the state delta comes - what a search at that moment reads
        t.onEnded = async id => {
            const [item] = await browser.downloads.search({id});

            t.record('search at the end event', `${t.label(id)}: ${describeItem(item)}`);
        };

        const [entry] = await download(t, [{
            label: 'large',
            filename: 'large.bin',
            blob: binaryBlob(LARGE_BYTES),
            async afterResolve(id) {
                t.record('cancel()', 'large  // right after the search at the resolve');

                try {
                    await browser.downloads.cancel(id);
                    t.record('cancel() resolved', 'large');
                } catch (error) {
                    t.record('cancel() rejected', `large: ${scrub(error.message)}`);
                }
            },
        }]);

        t.expect('large: the interruption is announced by onChanged after the resolve (BEHAVIOR-DOWNLOADS.md §4)', [entry.endedAt !== null, entry.endedBeforeResolve], [true, false]);
        t.expect('large: interrupted with USER_CANCELED and no file at the end (§4)', [entry.final?.state, entry.final?.error, entry.final?.exists], ['interrupted', 'USER_CANCELED', false]);
    },
},

{
    id: 'R33.06',
    title: 'the object url of the large file revoked right after the resolve, the download in progress - does it still complete, or end interrupted and with what error: the shape File.save had in 2018-2020, the url revoked once a 5 s wait ran out (issue #374)',
    async run(t) {
        await platform(t);
        t.watch(SPECS);

        const [entry] = await download(t, [{
            label: 'large',
            filename: 'large.bin',
            blob: binaryBlob(LARGE_BYTES),
            afterResolve(id, url) {
                t.record('URL.revokeObjectURL()', 'large  // right after the search at the resolve, the download in progress');
                URL.revokeObjectURL(url);
            },
        }]);

        t.expect('large: the end is announced by onChanged after the resolve, the url revoked (BEHAVIOR-DOWNLOADS.md §5)', [entry.endedAt !== null, entry.endedBeforeResolve], [true, false]);
        t.expect('large: complete and existing at the end, the url revoked (§5)', [entry.final?.state, entry.final?.exists], [COMPLETE, true]);
    },
},

{
    id: 'R33.07',
    title: 'MANUAL: saveAs: true, the Save As dialog answered by the user - canceled first, then saved: is the cancel a rejection of download() and with what text, or a download that ends interrupted; the events of the saved one against the resolve',
    async run(t) {
        await platform(t);
        t.watch(SPECS);

        await t.ask('When you answer, a Save As dialog opens in the browser window - maybe behind this devtools window. Press CANCEL in it. Answer with anything, e.g. T.visualAnswer(\'ok\')');

        const [canceled] = await download(t, [{label: 'canceled', filename: 'saveas.json', saveAs: true, blob: jsonBlob(SMALL_BYTES)}]);

        t.expect('canceled: download() rejected with "Download canceled by the user", no item (BEHAVIOR-DOWNLOADS.md §6)', [canceled.id, canceled.error], [null, 'Download canceled by the user']);

        await t.ask('When you answer, a Save As dialog opens again in the browser window. Press SAVE, keep the suggested name and folder. Answer with anything, e.g. T.visualAnswer(\'ok\')');

        const [saved] = await download(t, [{label: 'saved', filename: 'saveas.json', saveAs: true, blob: jsonBlob(SMALL_BYTES)}]);

        t.expect('saved: the end is announced by onChanged after the resolve (§6)', [saved.endedAt !== null, saved.endedBeforeResolve], [true, false]);
        t.expect('saved: complete and existing at the end (§6)', [saved.final?.state, saved.final?.exists], [COMPLETE, true]);
    },
},

{
    id: 'R33.08',
    title: 'a download that fails on its own, from an https host no server answers for - does download() resolve or reject, which onChanged announce the failure, are state and error in one delta or in two, what search says right at the state delta and at the end: the failed branch of File.save without a user',
    async run(t) {
        await platform(t);
        t.watch(SPECS);

        // is the reason there already when the state delta comes, the way it was not for a cancel (BEHAVIOR-DOWNLOADS.md §4)
        let atEnd = null;

        t.onEnded = async id => {
            [atEnd] = await browser.downloads.search({id});

            t.record('search at the end event', `${t.label(id)}: ${describeItem(atEnd)}`);
        };

        const [entry] = await download(t, [{label: 'unreachable', filename: 'unreachable.bin', url: UNREACHABLE_URL}]);

        t.expect('unreachable: download() resolves, the failure is announced by onChanged after the resolve (BEHAVIOR-DOWNLOADS.md §7)', [entry.id !== null, entry.endedAt !== null, entry.endedBeforeResolve], [true, true, false]);
        t.expect('unreachable: the reason is readable already at the state delta (§7)', [atEnd?.state, atEnd?.error], ['interrupted', 'NETWORK_FAILED']);
        t.expect('unreachable: interrupted with NETWORK_FAILED and no file at the end (§7)', [entry.final?.state, entry.final?.error, entry.final?.exists], ['interrupted', 'NETWORK_FAILED', false]);
    },
},

];
