import {ROUNDS, RUN_KEY, LOGS_KEY, BATCH_GAP} from './constants.js';
import {wait, RestartRequested} from './test.js';
import {TabsTest, closeHarnessWindows, nameFromUrl} from './tabs.js';

let running = false;
let stopping = false;
let awaitingAnswer = null;

const loadRun = () => JSON.parse(localStorage.getItem(RUN_KEY) ?? 'null');
const saveRun = state => localStorage.setItem(RUN_KEY, JSON.stringify(state));
const dropRun = () => localStorage.removeItem(RUN_KEY);

const loadRound = round => import(`${browser.runtime.getURL(`tests/${round}.js`)}?v=${Date.now()}`);

async function openResults() {
    const tab = await browser.tabs.create({url: browser.runtime.getURL('results.html'), active: true});

    await browser.windows.update(tab.windowId, {focused: true});

    return tab;
}

async function askUser(test, question) {
    const described = await test.describe();

    console.debug([
        `👁️  ${test.data.id}  question ${test.data.asked.length + 1}`,
        ...described,
        `> ${question}`,
        `answer with:  T.visualAnswer('what you see')      not looked at:  T.visualAnswer()`,
    ].join('\n'));

    const {promise, resolve} = Promise.withResolvers();

    awaitingAnswer = resolve;
    const answer = await promise;
    awaitingAnswer = null;

    return answer;
}

async function cleanup(state, test) {
    const closed = await closeHarnessWindows();
    const cleared = [];

    for (const name of state.settings) {
        await test.clearSetting(name);
        cleared.push(name);
    }

    state.settings = [];

    if (closed.length || cleared.length) {
        const parts = [];

        if (closed.length) {
            parts.push(`closed ${closed.length} leftover window(s)`);
        }

        if (cleared.length) {
            parts.push(`restored setting(s): ${cleared.join(', ')}`);
        }

        test.note(`cleaned up before the test — ${parts.join('; ')}`);
    }
}

function collect(state, test) {
    state.reports.push(test.render());
    state.counts.tests++;
    state.counts.mismatches += test.data.checks.filter(check => !check.ok).length;
    state.counts.answers += test.data.asked.length;

    if (test.data.failed) {
        state.counts.failed++;
        state.failures.push(`${test.data.id} — ${test.data.failed}`);
    }

    state.settings = [...new Set([...state.settings, ...test.data.settings])];
}

async function runTest(state, spec, TestClass, round, url) {
    const test = new TestClass({id: spec.id, title: spec.title, url: spec.url ?? url, round, onQuestion: askUser});
    const started = Date.now();

    await cleanup(state, test);

    let suspended = false;

    try {
        await spec.run(test);
    } catch (error) {
        if (error instanceof RestartRequested) {
            suspended = true;
        } else {
            test.data.failed = error.message;
        }
    }

    const touched = [...test.data.settings];
    await test.finish();

    if (suspended) {
        state.settings = [...new Set([...state.settings, ...touched])];
        state.pending = {round, data: test.data};
        saveRun(state);

        console.debug([
            `⏸  ${spec.id} needs a browser restart`,
            'the scene window is left open on purpose — keep it',
            'restart Firefox, load the add-on again in about:debugging, then run:  T.continue()',
        ].join('\n'));

        return false;
    }

    await test.close();
    collect(state, test);

    const marks = test.data.checks.filter(check => !check.ok).length;
    const verdict = test.data.failed ? 'FAILED' : marks ? `${marks} MISMATCH` : 'ok';

    console.debug(`${round}  ${spec.id}  ${verdict}  ${Date.now() - started} ms`);

    return true;
}

async function resumeRestart(state) {
    const {round, data} = state.pending;
    const module = await loadRound(round);
    const spec = module.tests.find(test => test.id === data.id);
    const TestClass = module.testClass ?? TabsTest;
    const test = new TestClass({id: data.id, title: data.title, url: spec?.url ?? module.url, round, onQuestion: askUser, data});

    try {
        await test.reattach();
        await spec.afterRestart(test);
    } catch (error) {
        test.data.failed = error.message;
    }

    await test.finish();
    await test.close();
    collect(state, test);

    console.debug(`${round}  ${data.id}  ${test.data.failed ? 'FAILED' : 'ok'}  (after restart)`);

    state.pending = null;
    state.index++;
    saveRun(state);
}

function finalize(state, reason) {
    const summary = [
        '## summary',
        '',
        `${state.counts.tests} test(s), ${state.counts.mismatches} mismatch(es), ${state.counts.failed} failed, ${state.counts.answers} 👁️ answer(s)`,
        ...(state.failures.length ? ['', 'failed:', ...state.failures.map(line => `- ${line}`)] : []),
        ...(reason === 'stopped' ? ['', 'the run was stopped with T.stop() — the rounds below it never ran'] : []),
    ].join('\n');

    localStorage.setItem(LOGS_KEY, [...state.reports, summary].join('\n\n'));
    dropRun();

    console.debug(`=== ${reason}: ${state.counts.tests} test(s), ${state.counts.mismatches} mismatch(es), ${state.counts.failed} failed — full report in the tab that just opened, and in T.logs() ===`);

    return openResults();
}

async function drive(state) {
    running = true;
    stopping = false;

    try {
        if (state.pending) {
            await resumeRestart(state);
        }

        while (state.queue.length) {
            const [round, ...only] = state.queue[0].split(':');
            const module = await loadRound(round);
            const TestClass = module.testClass ?? TabsTest;
            const gap = module.gap ?? BATCH_GAP;

            if (!Array.isArray(module.tests)) {
                throw new Error(`tests/${round}.js must export an array named "tests"`);
            }

            const tests = only.length ? module.tests.filter(test => only.includes(test.id)) : module.tests;

            if (!tests.length) {
                throw new Error(`${state.queue[0]} matched no test`);
            }

            if (state.index === 0) {
                state.reports.push(`## ${round}${module.note ? `\n\n${module.note}` : ''}`);
                console.debug(`=== ${round}: ${tests.length} test(s) ===`);
            }

            while (state.index < tests.length) {
                if (stopping) {
                    saveRun(state);
                    return finalize(state, 'stopped');
                }

                const finished = await runTest(state, tests[state.index], TestClass, round, module.url);

                if (!finished) {
                    return;
                }

                state.index++;
                saveRun(state);

                if (state.index < tests.length) {
                    await wait(gap);
                }
            }

            state.queue.shift();
            state.index = 0;
            saveRun(state);
        }

        return finalize(state, 'done');
    } finally {
        running = false;
    }
}

async function start(...rounds) {
    if (running) {
        return 'a run is already going — T.stop() first';
    }

    if (loadRun()?.pending) {
        return 'a run is waiting for a browser restart — T.continue() to pick it up, or T.forget() to drop it';
    }

    const queue = rounds.flat().filter(Boolean);

    if (!queue.length) {
        queue.push(...ROUNDS);
    }

    await drive({
        queue,
        index: 0,
        pending: null,
        reports: [`# STG behavior test run`, `rounds: ${queue.join(', ')}`],
        counts: {tests: 0, mismatches: 0, failed: 0, answers: 0},
        failures: [],
        settings: [],
    });
}

async function resume() {
    if (running) {
        return 'a run is already going';
    }

    const state = loadRun();

    if (!state) {
        return 'nothing to continue — no checkpoint';
    }

    await drive(state);
}

function stop() {
    if (!running) {
        return 'nothing is running';
    }

    stopping = true;
    awaitingAnswer?.('(stopped)');

    return 'stopping after the current test';
}

function visualAnswer(text = '(not looked at)') {
    if (!awaitingAnswer) {
        return 'nothing is waiting for an answer';
    }

    awaitingAnswer(text);

    return 'recorded';
}

async function report(title = 'current state') {
    const test = new TabsTest({id: title, title: '', round: 'report', onQuestion: askUser});

    for (const [position, win] of (await browser.windows.getAll({windowTypes: ['normal']})).entries()) {
        const tabs = (await browser.tabs.query({windowId: win.id})).sort((a, b) => a.index - b.index);

        for (const tab of tabs) {
            const name = nameFromUrl(tab.url);

            if (name) {
                test.bind(tab.id, name);
            }
        }

        test.win = win.id;
        test.row(`window ${position + 1}`, tabs.map(tab => test.cell(tab)), {groups: await test.groupsInfo()});
    }

    test.win = null;
    await test.finish();

    console.debug(test.render());
}

function forget() {
    dropRun();
    return 'checkpoint dropped';
}

globalThis.T = {
    start,
    continue: resume,
    stop,
    forget,
    visualAnswer,
    report,
    logs: openResults,
};

console.debug([
    'STG behavior test harness ready',
    '  T.start()                          every round in order',
    "  T.start('round-05')                one round",
    "  T.start('round-01', 'round-07')    a few rounds",
    '  T.visualAnswer(\'…\')              answer a 👁️ question the run is waiting on',
    '  T.continue()                     pick a run back up after a restart or a reload',
    '  T.stop()                         end the run after the current test',
    '  T.logs()                         open the last report again',
].join('\n'));
