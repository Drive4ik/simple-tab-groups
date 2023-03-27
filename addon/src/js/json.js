
function getCircularReplacer() {
    const seen = new WeakSet();

    return (key, value) => {
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
                return;
            }

            seen.add(value);
        }

        return value;
    };
}

export function stringify(obj = null, space = null) {
    return JSON.stringify(obj, getCircularReplacer(), space);
}

export function clone(obj = null) {
    return JSON.parse(stringify(obj));
}

export function parse(...args) {
    return JSON.parse(...args);
}

export default {stringify, clone, parse};
