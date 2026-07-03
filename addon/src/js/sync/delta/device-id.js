import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';

const storage = localStorage.create(Constants.MODULES.CLOUD);

const DEVICE_ID_KEY = 'deviceId';
const DEVICE_LABEL_KEY = 'deviceLabel';

export function getDeviceId() {
    let deviceId = storage[DEVICE_ID_KEY];

    if (!deviceId) {
        deviceId = self.crypto.randomUUID();
        storage[DEVICE_ID_KEY] = deviceId;
    }

    return deviceId;
}

export function getDeviceLabel() {
    let label = storage[DEVICE_LABEL_KEY];

    if (!label) {
        label = Constants.BROWSER_FULL_NAME;
        storage[DEVICE_LABEL_KEY] = label;
    }

    return label;
}

export function setDeviceLabel(label) {
    storage[DEVICE_LABEL_KEY] = label;
}
