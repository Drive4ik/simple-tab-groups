
import * as Constants from './constants.js';
import JSON from './json.js';
import {nativeErrorToObject, objectToNativeError, PageStack} from './logger.js';

const CSPorts = new Set;
const pending = new Map;

export function normalizeSendData(action, data) {
    if (typeof action === 'object' && data === undefined) {
        return action;
    }

    return {...data, action};
}

export async function sendMessage(...args) {
    const message = normalizeSendData(...args);

    // self.logger?.info(`send Message ⚡️ "${message.action}"`);

    return browser.runtime.sendMessage(message)
        .catch(self.logger?.onCatch(['sendMessage', message]));
}

export function sendExternalMessage(exId, ...args) {
    const message = normalizeSendData(...args);

    self.logger?.info('sending', `SEND-EXTERNAL-MESSAGE#${message.action}`, 'to:', exId);

    return browser.runtime.sendMessage(exId, message).catch(() => {});
}

// MODULES
function getArgumentsModuleCall(ModuleFunc, ...args) {
    return [
        ModuleFunc,
        {
            args,
            breadcrumbs: nativeErrorToObject(new PageStack),
        }
    ];
}

export function sendMessageModule(...args) {
    return sendMessage(...getArgumentsModuleCall(...args));
}

export function connectToBackground(name, listeners = null, callback = null, autoDisconnectOnUnload = true) {
    const port = browser.runtime.connect({
        name: JSON.stringify({name, listeners}),
    });

    port.onMessage.addListener(message => {
        const {postId, result, error} = message;

        if (pending.has(postId)) {
            const {resolve, reject} = popPending(postId);

            if (error) {
                reject(objectToNativeError(error));
            } else {
                resolve(result);
            }
        } else {
            callback?.(message); // this is a single message from background without any waiting
        }
    });

    const disconnect = port.disconnect.bind(port);

    if (autoDisconnectOnUnload) {
        window.addEventListener('unload', disconnect);
    }

    return {
        sendMessage: (...args) => postMessageToBackground(port, ...args),
        sendMessageModule: (...args) => postMessageToBackground(port, ...getArgumentsModuleCall(...args)),
        disconnect,
    };
}

function popPending(postId) {
    const {resolve, reject, timer} = pending.get(postId) ?? {};

    clearTimeout(timer);
    pending.delete(postId);

    return {resolve, reject};
}

// RPC
async function postMessageToBackground(port, ...args) {
    const postId = self.crypto.randomUUID();
    const data = normalizeSendData(...args);
    const timerError = new Error(`RPC timeout, postId: ${postId}, args: ` + JSON.stringify(data));

    if (data.action !== 'save-log') {
        self.logger?.info(`postMessage#${data.action}`, `postId: ${postId} to background`);
    }

    const entry = Promise.withResolvers();

    entry.timer = setTimeout(() => {
        pending.delete(postId);
        entry.reject(timerError);
    }, 60_000 * 2); // 2 minutes

    pending.set(postId, entry);

    port.postMessage({
        postId,
        data,
    });

    return entry.promise;
}

// BACKGROUND
export function createListenerOnConnectedBackground(onMessageListener) {
    return port => {
        const {name, listeners} = JSON.parse(port.name);
        const CSPort = {name, port, listeners};

        CSPorts.add(CSPort);

        self.logger?.info(name, 'connected');

        // the second argument is "port"; but this is not described in https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/Port#onmessage
        port.onMessage.addListener(async message => {
            if (!message?.postId || !CSPorts.has(CSPort)) {
                return;
            }

            const {postId, data} = message;

            try {
                const result = await onMessageListener(data, port);

                if (CSPorts.has(CSPort)) {
                    port.postMessage({
                        postId,
                        result,
                    });
                } else {
                    popPending(postId);
                }
            } catch (error) {
                self.logger?.logError(['message:', message], error);

                if (CSPorts.has(CSPort)) {
                    port.postMessage({
                        postId,
                        error: nativeErrorToObject(error),
                    });
                } else {
                    popPending(postId);
                }
            }
        });

        port.onDisconnect.addListener(() => {
            CSPorts.delete(CSPort);
            self.logger?.info(name, 'disconnected');
        });
    }
}

export function sendMessageFromBackground(...args) {
    if (!Constants.IS_BACKGROUND_PAGE) {
        throw new Error('not background');
    }

    const message = normalizeSendData(...args);

    const portNamesSended = [];

    for (const {name, port, listeners} of CSPorts) {
        if (listeners?.includes('*') || listeners?.includes(message.action)) {
            port.postMessage(message);
            portNamesSended.push(name);
        }
    }

    self.logger?.info(`postMessage#${message.action}`, 'to ports', portNamesSended);

    return portNamesSended.length > 0;
}
