import {register} from 'node:module';

register(new URL('./sync-error-message.test.loader.mjs', import.meta.url));

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

const {syncErrorMessage} = await import('./cloud-helpers.js');
const {objectToNativeError} = await import('/js/logger.js');

const UPLOAD_TEXT = `Synchronization can't upload recent changes: the delta log is full.`;

const cloudErrorResult = {
    ok: false,
    name: 'CloudError',
    message: UPLOAD_TEXT,
    langId: 'syncDrainBroken',
    stack: 'deltaSynchronization@moz-extension://stg/js/sync/delta/delta-sync.js:400',
};

{
    const text = syncErrorMessage(cloudErrorResult);

    check('a CloudError sync result surfaces its plain message', text === UPLOAD_TEXT, text);
    check('no error-class prefix leaks into the text', !text.includes('CloudError'), text);
    check('no machine fallback name leaks into the text', !text.includes('objectToNativeError'), text);
    check('no extension prefix leaks into the text', !text.includes('[STG]'), text);
}

check('String() on the same object is exactly the garbage the helper exists to avoid',
    String(objectToNativeError(cloudErrorResult)) === `CloudError: ${UPLOAD_TEXT}`);

{
    const DRAIN_TEXT = 'The delta log cannot drain: 1200 un-synced events exceed the cap.';
    const drainBrokenResult = {
        ok: false,
        name: 'Error',
        langId: 'syncDrainBroken',
        message: DRAIN_TEXT,
        drainBroken: true,
        excess: 1200,
        cause: {
            name: 'CloudError',
            message: 'GitHub token is invalid.',
        },
    };

    const text = syncErrorMessage(drainBrokenResult);

    check('a drain-broken payload surfaces its own message', text === DRAIN_TEXT, text);
    check('the nested cause does not leak into the text', !text.includes('GitHub token'), text);
}

{
    const text = syncErrorMessage({ok: false, message: 'Synchronization is disabled.'});

    check('a nameless error object still surfaces its message',
        text === 'Synchronization is disabled.', text);
}

{
    const nativeError = new Error('Network request failed.');
    nativeError.name = 'CloudError';

    check('a native Error is accepted and reduced to its message',
        syncErrorMessage(nativeError) === 'Network request failed.');
}

{
    const text = syncErrorMessage({ok: false, inProgress: true});

    check('a message-less sync result has no text to show, so callers must not format it',
        text === 'objectToNativeError', text);
}

console.log(`\npassed: ${passed}, failed: ${failures.length}`);

if (failures.length) {
    process.exit(1);
}
