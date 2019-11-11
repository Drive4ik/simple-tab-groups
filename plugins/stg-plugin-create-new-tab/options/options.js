(async function() {
    'use strict';

    let $ = document.querySelector.bind(document),
        BG = browser.extension.getBackgroundPage(),
        containerSelect = $('#container-select');

    $('#container-header').innerText = browser.i18n.getMessage('selectContainer');

    init();

    browser.contextualIdentities.onCreated.addListener(init);
    browser.contextualIdentities.onUpdated.addListener(init);
    browser.contextualIdentities.onRemoved.addListener(init);

    containerSelect.addEventListener('change', async function() {
        await BG.setCookieStoreId(containerSelect.value);
        BG.updateBrowserAction();
    });

    async function init() {
        let savedCookieStoreId = await BG.getCookieStoreId(),
            containers = await browser.contextualIdentities.query({}),
            temporaryContainerTitle = browser.i18n.getMessage('temporaryContainerTitle');

        while (containerSelect.firstElementChild) {
            containerSelect.firstElementChild.remove();
        }

        containers.unshift({
            cookieStoreId: BG.TEMPORARY_CONTAINER,
            name: temporaryContainerTitle,
        });

        containers.forEach(function({cookieStoreId, name}) {
            if (name.startsWith(temporaryContainerTitle) && name !== temporaryContainerTitle) {
                return;
            }

            let option = document.createElement('option');

            option.value = cookieStoreId;
            option.innerText = name;
            option.selected = cookieStoreId === savedCookieStoreId;

            containerSelect.append(option);
        });
    }

})()
