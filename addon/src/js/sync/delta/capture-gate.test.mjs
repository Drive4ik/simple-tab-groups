/**
 * Standalone node test for the delta-capture gate (`capture-gate.js`).
 *
 * Plain `node capture-gate.test.mjs` (STG has no test runner). The module is pure:
 * `evaluateCaptureGate` decides whether capture may append (sync enabled AND a GitHub
 * token configured), and `createCaptureGate` wraps it in a TTL cache with explicit
 * invalidation so option changes take effect immediately while a token saved outside
 * the background's saveOptions choke point is still picked up within one TTL.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs); it uses
 * node globals (process, console) the browser config bans.
 */

import {evaluateCaptureGate, createCaptureGate, CAPTURE_GATE_TTL_MS} from './capture-gate.js';

let passed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) {
        passed++;
        console.log(`  PASS  ${name}`);
    } else {
        failures.push(name);
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

// --- 1. evaluateCaptureGate truth table --------------------------------------------
{
    check('open when sync is enabled and a token is configured',
        evaluateCaptureGate({syncEnable: true, githubGistToken: 'ghp_x'}) === true);
    check('closed when sync is disabled',
        evaluateCaptureGate({syncEnable: false, githubGistToken: 'ghp_x'}) === false);
    check('closed when syncEnable is missing',
        evaluateCaptureGate({githubGistToken: 'ghp_x'}) === false);
    check('closed when the token is empty',
        evaluateCaptureGate({syncEnable: true, githubGistToken: ''}) === false);
    check('closed when the token is missing',
        evaluateCaptureGate({syncEnable: true}) === false);
    check('closed when the token is not a string',
        evaluateCaptureGate({syncEnable: true, githubGistToken: 42}) === false);
    check('closed for a truthy but non-boolean syncEnable',
        evaluateCaptureGate({syncEnable: 1, githubGistToken: 'ghp_x'}) === false);
    check('closed for empty inputs', evaluateCaptureGate({}) === false);
}

// --- 2. TTL cache: one load serves repeated checks within the TTL ------------------
{
    let clock = 0;
    let loadCount = 0;
    let inputs = {syncEnable: true, githubGistToken: 'ghp_x'};
    const gate = createCaptureGate({
        loadInputs: async () => {
            loadCount++;
            return inputs;
        },
        now: () => clock,
    });

    check('first check loads and reports open', await gate.isOpen() === true);
    clock += 1_000;
    check('second check within the TTL is served from cache', await gate.isOpen() === true);
    check('only one load within the TTL', loadCount === 1, `loadCount=${loadCount}`);

    inputs = {syncEnable: true, githubGistToken: ''};
    clock += CAPTURE_GATE_TTL_MS;
    check('an expired TTL re-loads and picks up the removed token', await gate.isOpen() === false);
    check('the expiry issued exactly one more load', loadCount === 2, `loadCount=${loadCount}`);
}

// --- 3. concurrent first checks share one load --------------------------------------
{
    let loadCount = 0;
    let release;
    const gate = createCaptureGate({
        loadInputs: () => new Promise(resolve => {
            loadCount++;
            release = () => resolve({syncEnable: true, githubGistToken: 'ghp_x'});
        }),
        now: () => 0,
    });

    const p1 = gate.isOpen();
    const p2 = gate.isOpen();
    await Promise.resolve();
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    check('concurrent first checks issue exactly one load', loadCount === 1, `loadCount=${loadCount}`);
    check('both concurrent checks get the loaded value', r1 === true && r2 === true, `r1=${r1} r2=${r2}`);
}

// --- 4. invalidate() forces an immediate re-load ------------------------------------
{
    let loadCount = 0;
    let inputs = {syncEnable: false, githubGistToken: ''};
    const gate = createCaptureGate({
        loadInputs: async () => {
            loadCount++;
            return inputs;
        },
        now: () => 0,
    });

    check('closed while sync is unconfigured', await gate.isOpen() === false);
    check('still one load', loadCount === 1, `loadCount=${loadCount}`);

    inputs = {syncEnable: true, githubGistToken: 'ghp_x'};
    check('a cached closed gate stays closed within the TTL', await gate.isOpen() === false);

    gate.invalidate();
    check('invalidate() re-loads and opens the gate immediately', await gate.isOpen() === true);
    check('invalidate() issued exactly one more load', loadCount === 2, `loadCount=${loadCount}`);
}

// --- 5. a failed load fails closed, keeps a known value, and retries -----------------
{
    let clock = 0;
    let failLoad = true;
    let loadCount = 0;
    const gate = createCaptureGate({
        loadInputs: async () => {
            loadCount++;
            if (failLoad) {
                throw new Error('storage unavailable');
            }
            return {syncEnable: true, githubGistToken: 'ghp_x'};
        },
        now: () => clock,
    });

    check('a failed load with no prior value reports closed', await gate.isOpen() === false);

    failLoad = false;
    check('the next check retries after a failed load', await gate.isOpen() === true);
    check('two loads so far', loadCount === 2, `loadCount=${loadCount}`);

    failLoad = true;
    clock += CAPTURE_GATE_TTL_MS;
    check('a failed refresh keeps the last known value', await gate.isOpen() === true);
    check('the failed refresh did issue a load', loadCount === 3, `loadCount=${loadCount}`);

    failLoad = false;
    check('the check after a failed refresh retries again', await gate.isOpen() === true);
    check('the retry issued one more load', loadCount === 4, `loadCount=${loadCount}`);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
