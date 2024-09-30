
Storage.prototype.create = function(prefix, delimiter) {
    return createProxy(this, prefix, delimiter);
}

function createProxy(storage, prefixes, delimiter = '/') {
    prefixes = [prefixes].flat().filter(Boolean);

    const getKey = key => [...prefixes, key].filter(Boolean).join(delimiter);

    const handler = {
        get(target, prop, receiver) {
            if (prop === 'getItem') {
                return prop => this.get(target, prop, receiver);
            } else if (prop === 'setItem') {
                return (prop, value) => this.set(target, prop, value, receiver);
            } else if (prop === 'removeItem') {
                return prop => this.deleteProperty(target, prop);
            } else if (prop === 'clear') {
                return () => {
                    const prefix = getKey();

                    for (const key of Reflect.ownKeys(target)) {
                        if (key.startsWith(prefix)) {
                            Reflect.deleteProperty(target, key);
                        }
                    }
                }
            } else if (prop === 'create') {
                return (prefix, delimiter) => createProxy(target, getKey(prefix), delimiter);
            }

            try {
                prop = getKey(prop);

                const storageValue = Reflect.get(target, prop, receiver);

                return JSON.parse(storageValue ?? null);
            } catch (e) {
                return null;
            }
        },
        set(target, prop, value = null, receiver) {
            prop = getKey(prop);

            value = JSON.stringify(value, getCircularReplacer());

            return Reflect.set(target, prop, value, receiver);
        },
        has(target, prop) {
            prop = getKey(prop);

            return prop in target;
        },
        ownKeys(target) {
            const prefix = getKey();

            return Reflect.ownKeys(target).filter(key => key.startsWith(prefix));
        },
        deleteProperty(target, prop) {
            prop = getKey(prop);

            return Reflect.deleteProperty(target, prop);
        },
    };

    return new Proxy(storage, handler);
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
