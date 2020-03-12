(function() {
    'use strict';

    function errorEventMessage(message, data = null, showNotification = true) {
        return utils.stringify({message, data, showNotification});
    }

    function errorEventHandler(event) {
        event.preventDefault && event.preventDefault();
        event.stopImmediatePropagation && event.stopImmediatePropagation();

        let nativeError = event.error || event,
            data = null;

        if (undefined === nativeError || !String(nativeError.name).toLowerCase().includes('error')) {
            nativeError = Error(nativeError);
        }

        try {
            data = JSON.parse(nativeError.message);

            if (Number.isFinite(data)) {
                throw Error;
            }
        } catch (e) {
            data = nativeError;
        }

        let errorData = {
            time: (new Date).toISOString(),
            message: data.message,
            data: data.data,
            lineNumber: nativeError.lineNumber,
            stack: console.getErrorStack(nativeError),
        };

        console.logError(errorData);

        if (false !== data.showNotification) {
            utils.notify(browser.i18n.getMessage('whatsWrongMessage'), undefined, undefined, undefined, () => browser.runtime.openOptionsPage());
        }
    }

    window.errorEventHandler = errorEventHandler;
    window.errorEventMessage = errorEventMessage;

    window.addEventListener('error', errorEventHandler);

})();
