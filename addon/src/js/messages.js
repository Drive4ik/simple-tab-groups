
import * as Constants from './constants.js';
import JSON from './json.js';
import {nativeErrorToObj} from './logger-utils.js';

const CSPorts = new Set;
const pending = new Map;

export function normalizeSendData(action, data = {}) {
    if (typeof action === 'object' && arguments.length === 1) {
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
            from: nativeErrorToObj(new Error),
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
            const {resolve, reject, timer} = pending.get(postId);

            clearTimeout(timer);
            pending.delete(postId);

            if (error) {
                reject(error);
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

// RPC
async function postMessageToBackground(port, ...args) {
    const postId = self.crypto.randomUUID();
    const data = normalizeSendData(...args);
    const timerError = new Error(`RPC timeout, postId: ${postId}, args: ` + JSON.stringify(data));

    if (data.action !== 'save-log') {
        self.logger?.info(`postMessage#${data.action} postId:`, postId, 'to background');
    }

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(postId);
            reject(timerError);
        }, 60_000 * 2); // 2 minutes

        pending.set(postId, {resolve, reject, timer});

        port.postMessage({
            postId,
            data,
        });
    });
}

// BACKGROUND
export function createListenerOnConnectedBackground(onMessageListener) {
    return port => {
        const {name, listeners} = JSON.parse(port.name);

        self.logger?.info(name, 'connected');

        port.onMessage.addListener(async (message, ...postArgs) => {
            if (!message?.postId) {
                return;
            }

            try {
                const {postId, data} = message;

                const result = await onMessageListener(data, ...postArgs);

                port.postMessage({
                    postId,
                    result,
                });
            } catch (error) {
                self.logger?.logError(['message:', message], error);

                port.postMessage({
                    postId,
                    error: nativeErrorToObj(error),
                });
            }
        });

        if (listeners?.length) {
            const CSPort = {name, port, listeners};
            CSPorts.add(CSPort);
            port.onDisconnect.addListener(() => {
                CSPorts.delete(CSPort);
                self.logger?.info(name, 'disconnected');
            });
        }
    }
}

export function sendMessageFromBackground(...args) {
    if (!Constants.IS_BACKGROUND_PAGE) {
        throw Error('not background');
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
