import '/translate-page.js';
import * as Constants from '/constants.js';
import * as Utils from '/utils.js';

const $ = document.querySelector.bind(document),
    groupsSelect = $('#groups-select'),
    needInstallSTGExtension = $('#needInstallSTGExtension');

groupsSelect.addEventListener('change', async function() {
    const groupId = parseInt(groupsSelect.value, 10);

    await browser.storage.local.set({groupId});

    const backgroundSelf = await browser.runtime.getBackgroundPage();

    backgroundSelf?.updateBrowserAction();
});

browser.runtime.onMessageExternal.addListener(async (request, sender) => {
    if (sender.id !== Constants.STG_ID) {
        return;
    }

    const backgroundSelf = await browser.runtime.getBackgroundPage();

    if (backgroundSelf?.SUPPORTED_STG_ACTIONS.has(request?.action)) {
        init();
    }
});

try {
    await init();
} catch (e) {
    needInstallSTGExtension.href = Constants.STG_HOME_PAGE;
    needInstallSTGExtension.classList = 'showing';
}

async function init() {
    needInstallSTGExtension.classList = '';

    const {groupId} = await browser.storage.local.get('groupId'),
        {groupsList} = await Utils.sendExternalMessage('get-groups-list');

    groupsSelect.firstElementChild.selected = true;

    while (groupsSelect.firstElementChild.nextElementSibling) {
        groupsSelect.firstElementChild.nextElementSibling.remove();
    }

    groupsList.forEach(group => {
        const option = document.createElement('option');

        option.value = group.id;
        option.innerText = group.title;
        option.selected = group.id === groupId;

        groupsSelect.append(option);
    });

}
