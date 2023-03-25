(function() {
    'use strict';

    function normalizeSendData(action, data = {}) {
        return {action, ...data};
    }

    async function sendMessage(...args) {
        const message = normalizeSendData(...args);

        self.logger?.info(`send Message ⚡️ "${message.action}"`);

        return browser.runtime.sendMessage(message);
    }

    function connectToBackground(name, listeners = null, callback = null) {
        const port = browser.runtime.connect({
            name: JSON.stringify({name, listeners}),
        });

        if (callback) {
            port.onMessage.addListener(callback);
        }

        return {
            sendMessage: (...args) => port.postMessage(normalizeSendData(...args)),
            disconnect: port.disconnect.bind(port),
        };
    }

    const CSPorts = new Set;

    function onConnectedBackground(onMessageListener, port) {
        let {name, listeners} = JSON.parse(port.name);

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

    async function sendMessageFromBackground(...args) {
        const message = normalizeSendData(...args);

        CSPorts.forEach(({port, listeners}) => {
            if (listeners?.includes('*') || listeners?.includes(message.action)) {
                port.postMessage(message);
            }
        });
    }

    function initBackground(onMessageListener) {
        browser.runtime.onConnect.addListener(onConnectedBackground.bind(null, onMessageListener));

        return sendMessageFromBackground;
    }

    window.Messages = {
        sendMessage,
        sendMessageModule: (ModuleFunc, ...args) => sendMessage(ModuleFunc, {args}),
        initBackground,
        connectToBackground,
    };



})();
