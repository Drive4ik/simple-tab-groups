
import {channel} from '/js/broadcast.js';

const CloudBroadcast = channel('cloud');

export const {on, off} = CloudBroadcast;

export function send(action, data = {}) {
    CloudBroadcast.send({action, ...data});
}

export function onSyncUiRequestListener() {
    return CloudBroadcast.on('sync-ui-request', () => send('sync-ui-response'));
}
