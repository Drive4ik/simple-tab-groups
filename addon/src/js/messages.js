
import {nativeErrorToObj} from './logger-utils.js';

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

export function sendExternalMessage(exId, ...args) {
    const message = normalizeSendData(...args);

    self.logger?.info('sending', `SEND-EXTERNAL-MESSAGE#${message.action}`, 'to:', exId);

    return browser.runtime.sendMessage(exId, message).catch(() => {});
}

export function connectToBackground(name, listeners = null, callback = null, autoDisconnectOnUnload = true) {
    const port = browser.runtime.connect({
        name: JSON.stringify({name, listeners}),
    });

    if (callback) {
        port.onMessage.addListener(callback);
    }

    const disconnect = port.disconnect.bind(port);

    if (autoDisconnectOnUnload) {
        window.addEventListener('unload', disconnect);
    }

    return {
        sendMessage: (...args) => port.postMessage(normalizeSendData(...args)),
        sendMessageModule: (...args) => port.postMessage(normalizeSendData(...getArgumentsModuleCall(...args))),
        disconnect,
    };
}

const CSPorts = new Set;

function onConnectedBackground(onMessageListener, port) {
    const {name, listeners} = JSON.parse(port.name);

    self.logger?.info(name, 'connected');

    port.onMessage.addListener(onMessageListener);

    if (listeners?.length) {
        const CSPort = {
            port,
            listeners,
        };

        CSPorts.add(CSPort);

        port.onDisconnect.addListener(() => CSPorts.delete(CSPort));
    }
}

function sendMessageFromBackground(...args) {
    const message = normalizeSendData(...args);

    let sended = false;

    for (const {port, listeners} of CSPorts) {
        if (listeners?.includes('*') || listeners?.includes(message.action)) {
            port.postMessage(message);
            sended = true;
        }
    }

    return sended;
}

export function initBackground(onMessageListener) {
    browser.runtime.onConnect.addListener(onConnectedBackground.bind(null, onMessageListener));

    return sendMessageFromBackground;
}
