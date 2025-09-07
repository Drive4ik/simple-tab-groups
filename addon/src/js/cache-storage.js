
import * as Constants from './constants.js';
import backgroundSelf from './background.js';

const isMyProxySymbol = Symbol('isMyProxy');
const isPrimitive = val => val !== Object(val);
const isPlainObject = obj => Object.prototype.toString.call(obj) === '[object Object]';

function createDeepCloneObjProxy(obj) {
    if (isPrimitive(obj)) {
        return obj;
    }

    const proxyObj = new Proxy(obj, {
        get(target, key) {
            return key === isMyProxySymbol ? true : Reflect.get(...arguments);
        },
        set(target, prop, value, receiver) {
            if (value?.[isMyProxySymbol]) { // call getter
                return Reflect.set(target, prop, value, receiver);
            }

            if (isPlainObject(value)) {
                // deserialize object to avoid DeadObject
                return Reflect.set(target, prop, createDeepCloneObjProxy({...value}), receiver);
            } else if (Array.isArray(value)) {
                // deserialize array to avoid DeadObject
                return Reflect.set(target, prop, createDeepCloneObjProxy([...value]), receiver);
            }

            // set primitive value
            return Reflect.set(target, prop, value, receiver);
        },
    });

    if (isPlainObject(proxyObj) || Array.isArray(proxyObj)) {
        for (let key in proxyObj) {
            proxyObj[key] = createDeepCloneObjProxy(proxyObj[key]);
        }
    }

    return proxyObj;
}

let _cacheStorage;

if (Constants.IS_BACKGROUND_PAGE) {
    // console.info('set cache-storage to background');
    _cacheStorage = backgroundSelf._cacheStorage = createDeepCloneObjProxy({});
} else {
    if (backgroundSelf) {
        // console.info('set cache-storage from background');
        _cacheStorage = backgroundSelf._cacheStorage;
    } else {
        // console.warn('create new cache-storage');
        _cacheStorage = createDeepCloneObjProxy({}); // create clear storage
    }
}

export {createDeepCloneObjProxy as createStorage};

export default _cacheStorage;
