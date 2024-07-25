import '/translate-page.js';
import * as Constants from '/constants.js';
import * as Utils from '/utils.js';

const $ = document.querySelector.bind(document),
    groupsSelect = $('#groups-select'),
    groupIcon = $('#group-icon'),
    needInstallSTGExtension = $('#needInstallSTGExtension');

groupIcon.addEventListener('load', () => groupIcon.hidden = false);
groupIcon.addEventListener('error', () => groupIcon.hidden = true);

groupsSelect.addEventListener('change', async () => {
    const [option] = groupsSelect.selectedOptions;

    await browser.storage.local.set({groupId: option.value});

    groupIcon.src = option.dataset.iconUrl;

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
        option.dataset.iconUrl = group.iconUrl;

        if (option.selected) {
            groupIcon.src = option.dataset.iconUrl;
        }

        groupsSelect.append(option);
    });

}
