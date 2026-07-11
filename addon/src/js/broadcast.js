import {
    ANY_ACTION,
    actionsSet,
    normalizeMessage,
    addActionHandler,
    removeHandlers,
    dispatchActionHandlers,
} from './channel-utils.js';

export {ANY_ACTION} from './channel-utils.js';

export const CHANNEL_NAME = new URL(import.meta.url).searchParams.get('channel') || 'stg';

const channels = new Map;

export function channel(channelName) {
    if (channels.has(channelName)) {
        return channels.get(channelName);
    }

    const handlersByAction = new Map;
    const messageErrorHandlers = new Set;

    const broadcastChannel = new BroadcastChannel(channelName);

    broadcastChannel.addEventListener('message', handleMessage, false);
    broadcastChannel.addEventListener('messageerror', handleMessageError, false);

    function handleMessage(event) {
        dispatchMessage(event.data, event);
    }

    function handleMessageError(event) {
        if (!messageErrorHandlers.size) {
            console.error(BroadcastChannel.name, channelName, 'error', event, 'remote');
            return;
        }

        for (const func of messageErrorHandlers) {
            try {
                func(event, 'remote');
            } catch (error) {
                console.error(error, channelName, 'event:', event);
            }
        }
    }

    function dispatchMessage(data, event) {
        dispatchActionHandlers(
            handlersByAction,
            data,
            handler => {
                try {
                    handler.func(data, event);
                } catch (error) {
                    console.error(error, channelName, 'data:', data, 'event:', event);
                }
            }
        );
    }

    function on(actions, func) {
        actions = actionsSet(actions);

        for (const action of actions) {
            addActionHandler(
                handlersByAction,
                action,
                {func},
                handler => handler.func === func
            );
        }

        return () => off(func, actions);
    }

    function off(func = null, actions = ANY_ACTION) {
        return removeHandlers(handlersByAction, func, actions);
    }

    function offActions(actions = null) {
        return off(null, actions);
    }

    function onMessageError(func) {
        messageErrorHandlers.add(func);
        return () => offMessageError(func);
    }

    function offMessageError(func) {
        return messageErrorHandlers.delete(func);
    }

    function send(action, {localOnly = false, includeSelf = true} = {}) {
        const message = normalizeMessage(action);

        if (!localOnly) {
            broadcastChannel.postMessage(message);
        }

        if (includeSelf) {
            dispatchMessage(message, null);
        }

        return message;
    }

    const instance = {
        name: channelName,
        on,
        off,
        offActions,
        onMessageError,
        offMessageError,
        send,
    };

    channels.set(channelName, instance);

    return instance;
}

export const {on, off, offActions, onMessageError, offMessageError, send} = channel(CHANNEL_NAME);
