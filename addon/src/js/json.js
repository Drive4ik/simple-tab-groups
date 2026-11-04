
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

export function stringify(obj = null, replacer = null, space = null) {
    const circular = getCircularReplacer();

    return JSON.stringify(obj, replacer ? (key, value) => circular(key, replacer(key, value)) : circular, space);
}

export function clone(obj = null) {
    return JSON.parse(stringify(obj));
}

export function parse(...args) {
    return JSON.parse(...args);
}

export default {stringify, clone, parse};
