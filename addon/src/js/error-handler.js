(function() {
    'use strict';

    function errorEventMessage(message, data = null, showNotification = true) {
        return utils.stringify({message, data, showNotification});
    }

    function errorEventHandler(event) {
        event.preventDefault?.();
        event.stopImmediatePropagation?.();

        if (event.error?.includes?.('waiting background')) {
            console.log(event.error);
            return;
        }

        if (!console.getErrorStack) { // background not inited
            return;
        }

        let nativeError = event.error || event,
            data = null;

        if (!nativeError || !String(nativeError?.name).toLowerCase().includes('error')) {
            nativeError = new Error(nativeError);
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
            ...JSON.parse(JSON.stringify(data, Object.getOwnPropertyNames(data))),
            stack: console.getErrorStack(nativeError),
        };

        // no longer needed?
        /* if (String(nativeError).includes('unexpected error')) {
            browser.tabs.create({
                active: true,
                url: browser.runtime.getURL('/help/db-error-reinstall.html'),
            }).catch(noop);
        } */

        // if (/^(invalid (tab|window))/i.test(errorData.message) && !window.localStorage.lastReloadFromError) {
        //     window.localStorage.lastReloadFromError = 1;
        //     console.addErrorLog(errorData);
        //     browser.runtime.reload();
        //     return;
        // }

        console.logError(errorData);

        if (false !== data.showNotification) {
            utils.notify(
                ['whatsWrongMessage'],
                undefined,
                'whatsWrongMessage',
                '/icons/exclamation-triangle-yellow.svg',
                () => browser.runtime.openOptionsPage()
            ).catch(() => {});
        }
    }

    window.errorEventHandler = errorEventHandler;
    window.errorEventMessage = errorEventMessage;

    window.addEventListener('error', errorEventHandler);
    window.addEventListener('unhandledrejection', e => errorEventHandler(e.reason));

})();
