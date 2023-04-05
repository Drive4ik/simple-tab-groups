/* STORAGE
USAGE

import ls from './ls.js'

ls.get('key')
ls.set('key', 'value', 300)
ls.rem('key') or
ls.del('key')

OR

const myLocalStorage = ls.create('my-prefix', TYPE_LOCAL);
myLocalStorage.get('key')
myLocalStorage.set('key', 'value', 300)
myLocalStorage.rem('key') or
myLocalStorage.del('key')

*/
function _localStorage(method, key, value) {
    const type = this?.type || TYPE_LOCAL;
    const prefix = this?.prefix;

    const args = [];

    if (prefix) {
        args.push(`${prefix}_${key}`);
    } else {
        args.push(`${key}`);
    }

    if (value !== undefined) {
        args.push(value);
    }

    return self[type][method](...args);
}

function setls(key, value = null, expiresSec = 0) {
    if (value === null || expiresSec < 0) {
        return remls.call(this, key);
    }

    _localStorage.call(this, 'setItem', key, JSON.stringify({
        expires: expiresSec === 0 ? null : Date.now() + expiresSec * 1000,
        value,
    }));
}

function getls(key, defaultValue = null) {
    let valueJSON = null;

    try {
        valueJSON = JSON.parse(_localStorage.call(this, 'getItem', key));
    } catch (e) {
        console.error(e);
    }

    if (valueJSON === null || valueJSON === '') {
        return defaultValue;
    }

    if (valueJSON.expires && valueJSON.expires < Date.now()) {
        remls.call(this, key);
        return defaultValue;
    }

    return valueJSON.value;
}

function remls(key) {
    _localStorage.call(this, 'removeItem', key);
}

const ls = {
    get: getls,
    set: setls,
    rem: remls,
    del: remls,
};

export const TYPE_LOCAL = 'localStorage';
export const TYPE_SESSION = 'sessionStorage';

export default {
    ...ls,
    create(prefix, type = TYPE_LOCAL) {
        return Object.keys(ls).reduce((acc, key) => (acc[key] = ls[key].bind({prefix, type}), acc), {});
    },
}
