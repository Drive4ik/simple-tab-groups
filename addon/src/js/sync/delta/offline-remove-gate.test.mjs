import {
    isMassOfflineRemoval,
    partitionOfflineRemoves,
    MASS_REMOVE_MIN_BASELINE,
    MASS_REMOVE_FRACTION,
    MASS_REMOVE_ABSOLUTE,
} from './offline-remove-gate.js';

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

function removes(n) {
    return Array.from({length: n}, (_, i) => ({op: 'tab.remove', groupId: 'g', uid: `u${i}`}));
}

check('zero removes is never a mass removal', !isMassOfflineRemoval(0, 100));

check('small offline churn below the fraction is auto-applied',
    !isMassOfflineRemoval(3, 100));

check('a fraction (>= half) of a meaningful baseline is a mass removal',
    isMassOfflineRemoval(Math.ceil(20 * MASS_REMOVE_FRACTION), 20));

check('just under half of a meaningful baseline is NOT a mass removal',
    !isMassOfflineRemoval(Math.ceil(20 * MASS_REMOVE_FRACTION) - 1, 20));

check('tiny baseline never trips the fraction test even at 100% gone',
    !isMassOfflineRemoval(MASS_REMOVE_MIN_BASELINE - 1, MASS_REMOVE_MIN_BASELINE - 1));

check('absolute backstop trips even against a huge baseline (below fraction)',
    isMassOfflineRemoval(MASS_REMOVE_ABSOLUTE, 100000));

check('session-restore-off signature (all of baseline gone) is a mass removal',
    isMassOfflineRemoval(40, 40));

{
    const {apply, deferred} = partitionOfflineRemoves(removes(3), 100);
    check('partition: ordinary churn applies all, defers none',
        apply.length === 3 && deferred.length === 0, JSON.stringify({apply: apply.length, deferred: deferred.length}));
}

{
    const {apply, deferred} = partitionOfflineRemoves(removes(40), 40);
    check('partition: mass wipe applies none, defers all',
        apply.length === 0 && deferred.length === 40, JSON.stringify({apply: apply.length, deferred: deferred.length}));
}

{
    const {apply, deferred} = partitionOfflineRemoves([], 100);
    check('partition: empty input yields empty apply/deferred',
        apply.length === 0 && deferred.length === 0);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error('FAILURES:', failures.join(', '));
    process.exit(1);
}
