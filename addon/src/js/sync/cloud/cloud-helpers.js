
import {channel} from '/js/broadcast.js';
import {objectToNativeError} from '/js/logger.js';

const CloudBroadcast = channel('cloud');

export const {on, off} = CloudBroadcast;

export function send(action, data = {}) {
    CloudBroadcast.send({action, ...data});
}

export function onSyncUiRequestListener() {
    return CloudBroadcast.on('sync-ui-request', () => send('sync-ui-response'));
}

export function syncErrorMessage(errorObject) {
    const error = objectToNativeError(errorObject);
    return error.message || String(error);
}
