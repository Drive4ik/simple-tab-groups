
/*
const main = sessionStorage.create('main');
main.mainKey = {};
main.mainKey.mainKeyIncludes = {};
main.mainKey.mainKeyIncludes.dynamicKey = 'dynamic-value';

sessionStorage:
"main/mainKey": '{"mainKeyIncludes":{"dynamicKey":"dynamic-value"}}'

const sub = main.create('sub');
sub.subKey = 'sub-value';

sessionStorage:
"main/sub/subKey": '"sub-value"'
*/

Storage.prototype.create = function(prefix, delimiter) {
    return createProxy(this, prefix, delimiter);
}

function createProxy(storage, prefix, delimiter = '/') {
    const getKey = (key = '') => `${prefix}${delimiter}${key}`;

    const handler = {
        get(target, prop, receiver) {
            if (prop === 'getItem') {
                return prop => this.get(target, prop, receiver);
            } else if (prop === 'setItem') {
                return (prop, value) => this.set(target, prop, value, receiver);
            } else if (prop === 'removeItem') {
                return prop => this.deleteProperty(target, prop);
            } else if (prop === 'clear') {
                return (withSubStorages = false) => {
                    if (withSubStorages) { // remove all with sub-storages, all keys which starts with prefix/
                        const prefixKey = getKey();

                        for (const key of Reflect.ownKeys(target)) {
                            if (key.startsWith(prefixKey)) {
                                Reflect.deleteProperty(target, key);
                            }
                        }
                    } else { // remove only keys which only in current prefix storage without sub-storages
                        for (const key of Object.keys(receiver)) {
                            Reflect.deleteProperty(target, getKey(key));
                        }
                    }
                }
            } else if (prop === 'create') {
                return (prefix, delimiter) => createProxy(target, getKey(prefix), delimiter);
            }

            try {
                prop = getKey(prop);
                const storageValue = Reflect.get(target, prop, receiver);
                if (storageValue) {
                    const value = JSON.parse(storageValue);

                    if (value && typeof value === 'object') {
                        return liveValue(value, () => Reflect.set(target, prop, JSON.stringify(value, getCircularReplacer()), receiver));
                    }

                    return value;
                }
            } catch { }
        },
        set(target, prop, value = null, receiver) {
            prop = getKey(prop);
            value = JSON.stringify(value, getCircularReplacer());
            return Reflect.set(target, prop, value, receiver);
        },
        has(target, prop) {
            prop = getKey(prop);
            return Reflect.has(target, prop);
        },
        ownKeys(target) {
            const prefix = getKey();
            return Reflect.ownKeys(target)
                .filter(key => key.startsWith(prefix))
                .map(key => key.replace(prefix, ''))
                .filter(key => !key.includes(delimiter));
        },
        deleteProperty(target, prop) {
            prop = getKey(prop);
            return Reflect.deleteProperty(target, prop);
        },
        // eslint-disable-next-line no-unused-vars
        getOwnPropertyDescriptor(target, prop) { // need for ownKeys
            return {
                configurable: true,
                enumerable: true,
                writable: true,
                // value: target[prop],
            };
        },
    };

    return new Proxy(storage, handler);
}

function liveValue(value, commit) {
    return new Proxy(value, {
        get(target, prop, receiver) {
            const propValue = Reflect.get(target, prop, receiver);

            if (propValue && typeof propValue === 'object') {
                return liveValue(propValue, commit);
            }

            return propValue;
        },
        set(target, prop, propValue, receiver) {
            const result = Reflect.set(target, prop, propValue, receiver);
            commit();
            return result;
        },
        deleteProperty(target, prop) {
            const result = Reflect.deleteProperty(target, prop);
            commit();
            return result;
        },
    });
}

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
