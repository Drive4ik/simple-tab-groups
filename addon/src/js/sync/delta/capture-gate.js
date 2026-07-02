export const CAPTURE_GATE_TTL_MS = 60_000;

export function evaluateCaptureGate({syncEnable, githubGistToken}) {
    return syncEnable === true
        && typeof githubGistToken === 'string'
        && githubGistToken.length > 0;
}

export function createCaptureGate({loadInputs, ttlMs = CAPTURE_GATE_TTL_MS, now = Date.now}) {
    let value = null;
    let refreshedAt = 0;
    let refreshing = null;

    return {
        async isOpen() {
            if (value !== null && now() - refreshedAt < ttlMs) {
                return value;
            }

            refreshing ??= loadInputs().then(inputs => {
                value = evaluateCaptureGate(inputs);
                refreshedAt = now();
                refreshing = null;
                return value;
            }, () => {
                refreshing = null;
                return value ?? false;
            });

            return refreshing;
        },
        invalidate() {
            value = null;
            refreshedAt = 0;
        },
    };
}
