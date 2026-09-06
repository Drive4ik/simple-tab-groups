export const note = `Round 19 — browser shutdown seen from inside the addon: which close events are
delivered while the process is going down, and whether writes started from them land. The probe
mirrors the STG tabsToRestore path exactly: tabs.onRemoved {isWindowClosing: true} feeds an
in-memory list, windows.onRemoved snapshots and clears it, reads storage.local and writes the
merge back. Delivery is recorded synchronously into the background page's localStorage; each
windows.onRemoved chain also embeds a copy of that log into its storage.local record, so the two
channels cross-check each other. What is verified beforehand is only that writes made BEFORE the
shutdown survive the trip (LIFECYCLE-BEHAVIOR §3; the checkpoint of this very harness makes the
same trip) — a baseline in both channels asserts that. Whether a write made DURING the shutdown
is flushed at all is part of what the round measures, so an absent record is never read as
"the event was not delivered".

PRECONDITION: about:preferences → Startup → "Open previous windows and tabs" must be ON.`;

const LOG_KEY = 'shutdownLog';
const BASELINE_KEY = 'shutdownBaseline';
const WRITE_KEY = 'shutdownWrite';

function installProbe(t) {
    const names = new Map(t.nameById);
    const sceneWin = t.win;
    const t0 = Date.now();
    const entries = [];
    const closedTabs = [];
    const foreign = new Map();

    const logSync = (event, detail) => {
        entries.push({at: Date.now() - t0, event, detail});

        try {
            localStorage.setItem(LOG_KEY, JSON.stringify(entries));
        } catch {}
    };

    const winName = windowId => {
        if (windowId === sceneWin) {
            return 'scene';
        }

        if (!foreign.has(windowId)) {
            foreign.set(windowId, `foreign${String.fromCharCode(65 + foreign.size)}`);
        }

        return foreign.get(windowId);
    };

    const onTabRemoved = (tabId, {windowId, isWindowClosing}) => {
        logSync('tabs.onRemoved', `${names.get(tabId) ?? 'foreign'}  isWindowClosing:${isWindowClosing}  [${winName(windowId)}]`);

        if (isWindowClosing) {
            closedTabs.push(names.get(tabId) ?? 'foreign');
        }
    };

    const onWindowRemoved = windowId => {
        const window = winName(windowId);
        const collected = closedTabs.splice(0);

        logSync('windows.onRemoved', `${window}  collected tabs: ${collected.join(', ') || '(none)'}`);

        const started = Date.now();

        browser.storage.local.get(WRITE_KEY).then(data => {
            logSync('storage.local.get resolved', `${window}  +${Date.now() - started}ms`);

            const records = data[WRITE_KEY] ?? [];
            records.push({window, tabs: collected, log: [...entries]});

            return browser.storage.local.set({[WRITE_KEY]: records});
        }).then(
            () => logSync('storage.local.set resolved', `${window}  +${Date.now() - started}ms`),
            error => logSync('storage chain rejected', `${window}  ${error.message}`),
        );

        browser.windows.getAll().then(
            windows => logSync('windows.getAll resolved', `${window}  ${windows.length} window(s) left`),
            error => logSync('windows.getAll rejected', `${window}  ${error.message}`),
        );
    };

    browser.tabs.onRemoved.addListener(onTabRemoved);
    browser.windows.onRemoved.addListener(onWindowRemoved);

    globalThis.shutdownProbe = {
        remove() {
            browser.tabs.onRemoved.removeListener(onTabRemoved);
            browser.windows.onRemoved.removeListener(onWindowRemoved);
            delete globalThis.shutdownProbe;
        },
    };
}

function removeProbe() {
    globalThis.shutdownProbe?.remove();
}

const formatEntry = ({at, event, detail}) => `+${String(at).padStart(4)}ms  ${event}  ${detail}`;

export const tests = [

{
    id: 'R19.01',
    title: 'browser shutdown: are tabs.onRemoved {isWindowClosing} and windows.onRemoved delivered, does the storage.local get → set chain started in windows.onRemoved land, do API calls still answer',
    async run(t) {
        await t.scene(['s1', 's2', 'sh1']);
        await t.hide(['sh1']);

        removeProbe();
        localStorage.removeItem(LOG_KEY);
        localStorage.setItem(BASELINE_KEY, 'written before the shutdown');
        await browser.storage.local.remove([BASELINE_KEY, WRITE_KEY]);
        await browser.storage.local.set({[BASELINE_KEY]: 'written before the shutdown'});

        installProbe(t);

        t.note('the probe is registered; every log line below was recorded during the shutdown and read back after the restart');

        await t.snap('before shutdown');
        t.expectRow('before shutdown', ['s1*', 's2', 'sh1(h)']);

        await t.restart('QUIT Firefox completely (≡ menu → Exit, or Ctrl+Shift+Q) leaving every window open, start it again, load the add-on in about:debugging ONCE, then run:  T.continue()');
    },
    async afterRestart(t) {
        const probeStillLive = Boolean(globalThis.shutdownProbe);
        removeProbe();

        const log = JSON.parse(localStorage.getItem(LOG_KEY) ?? 'null');
        const baselineSync = localStorage.getItem(BASELINE_KEY);
        const stored = await browser.storage.local.get([BASELINE_KEY, WRITE_KEY]);
        const written = stored[WRITE_KEY];

        localStorage.removeItem(LOG_KEY);
        localStorage.removeItem(BASELINE_KEY);
        await browser.storage.local.remove([BASELINE_KEY, WRITE_KEY]);

        const cleanTrip = t.rebirths === 1 && !probeStillLive;

        if (!cleanTrip) {
            t.note('⚠ NOT A CLEAN MEASUREMENT — see the aborted check below; the lines are kept only for debugging');
        }

        await t.settled();
        await t.snap('after restart');

        if (log) {
            t.note('the shutdown log (localStorage flushes asynchronously: present lines are evidence, a missing tail proves nothing):');
            log.forEach(entry => t.note(formatEntry(entry)));
        } else if (written) {
            t.note('the localStorage log is gone, but the storage.local record survived: close events WERE delivered, the shutdown-time localStorage flush was dropped; the log below is the copy embedded in the record');
            (written.findLast(record => record.log?.length)?.log ?? []).forEach(entry => t.note(formatEntry(entry)));
        } else {
            t.note('nothing recorded anywhere: either no close event was delivered, or every shutdown-time write was dropped — indistinguishable from inside the process');
        }

        t.note(`storage.local after the restart: ${written ? JSON.stringify(written.map(({window, tabs}) => ({window, tabs}))) : `no "${WRITE_KEY}" record — the chain's write did not persist: either it never started, or it started and the write was dropped`}`);

        const sceneRecord = written?.find(record => record.window === 'scene');
        t.note(`the scene window's write: ${sceneRecord ? `landed, tabs: ${sceneRecord.tabs.join(', ') || '(none)'}` : `did NOT land — if the log still says "storage.local.set resolved  scene", either the chains of two windows clobbered each other on the shared key (the way concurrent tabsToRestore writers can), or that set's flush was dropped`}`);
        t.note('sh1 was hidden before the shutdown — whether it shows up among the collected tabs above is the hidden-tab half of the fact');

        t.expectRow('after restart', ['s1*', 's2', 'sh1(h)']);
        t.expect("the scene window's chain landed with every tab, hidden included (LIFECYCLE-BEHAVIOR §8)", sceneRecord?.tabs, ['s1', 's2', 'sh1']);

        t.require('localStorage survived the restart', baselineSync !== null, 'the baseline written before the shutdown is gone — the sync channel proves nothing');
        t.require('storage.local survived the restart', stored[BASELINE_KEY] !== undefined, 'the baseline written before the shutdown is gone — the async channel proves nothing');
        t.require(
            'the browser was quit exactly once while the probe was armed',
            cleanTrip,
            probeStillLive
                ? 'the probe is still alive — the browser was never quit; quit it and re-run the round'
                : `add-on loads while the test was suspended: ${t.rebirths} (need exactly 1 — the load after the quit); re-run the round and load the add-on exactly once, after quitting`,
        );
    },
},

];
