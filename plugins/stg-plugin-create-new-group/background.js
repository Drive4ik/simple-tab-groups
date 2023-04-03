
const STG_ID = 'simple-tab-groups@drive4ik',
    STG_HOME_PAGE = 'https://addons.mozilla.org/firefox/addon/simple-tab-groups/';

browser.notifications.onClicked.addListener(() => {
    browser.tabs.create({
        url: STG_HOME_PAGE,
    });
});

browser.action.onClicked.addListener(async () => {
    const responce = await browser.runtime.sendMessage(STG_ID, {
        action: 'add-new-group',
    }).catch(() => {});

    if (responce) {
        if (responce.ok) {
            browser.runtime.sendMessage(STG_ID, {
                action: 'load-last-group',
            });
        } else {
            browser.notifications.create({
                type: 'basic',
                iconUrl: '/icons/icon.svg',
                title: browser.i18n.getMessage('extensionName'),
                message: responce.error,
            });
        }
    } else {
        browser.notifications.create({
            type: 'basic',
            iconUrl: '/icons/icon.svg',
            title: browser.i18n.getMessage('extensionName'),
            message: browser.i18n.getMessage('needInstallSTGExtension'),
        });
    }

});
