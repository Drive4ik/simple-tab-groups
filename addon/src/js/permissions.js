import Listeners from '/js/listeners.js\
?permissions.onAdded\
&permissions.onRemoved\
';
import * as Constants from './constants.js';

export const {
    BOOKMARKS,
    NATIVE_MESSAGING,
    BROWSER_SETTINGS,
} = Constants.PERMISSIONS;

export const {onAdded, onRemoved} = Listeners.permissions;

export async function has(permission) {
    return browser.permissions.contains(permission);
}

export async function request(permission) {
    return browser.permissions.request(permission);
}

export async function remove(permission) {
    return browser.permissions.remove(permission);
}

export function hasAll(change, def) {
    const c = normalize(change);
    const d = normalize(def);

    return c.permissions.isSupersetOf(d.permissions)
        && c.origins.isSupersetOf(d.origins);
}

export function hasAny(change, def) {
    const c = normalize(change);
    const d = normalize(def);

    return c.permissions.intersection(d.permissions).size > 0
        || c.origins.intersection(d.origins).size > 0;
}

function normalize({permissions, origins}) {
    return {
        permissions: new Set(permissions),
        origins: new Set(origins),
    };
}
