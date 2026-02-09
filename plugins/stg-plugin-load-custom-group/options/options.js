import Listeners from '/listeners.js?runtime.onMessageExternal';
import * as Constants from '/constants.js';
import * as Utils from '/utils.js';
import '/lang.js?translate-page&text';

const $ = document.querySelector.bind(document);
const groupsSelect = $('#groups-select');
const groupIcon = $('#group-icon');
const needInstallSTGExtension = $('#needInstallSTGExtension');

groupIcon.addEventListener('load', () => groupIcon.hidden = false);
groupIcon.addEventListener('error', () => groupIcon.hidden = true);

needInstallSTGExtension.href = Constants.STG_HOME_PAGE;

groupsSelect.addEventListener('change', async () => {
    const [option] = groupsSelect.selectedOptions;

    await browser.storage.local.set({
        groupId: option.value,
    });

    groupIcon.src = option.dataset.iconUrl;

    Utils.sendMessage('group-selected');
});

Listeners.runtime.onMessageExternal.add(async (request, sender) => {
    if (sender.id !== Constants.STG_ID) {
        return;
    }

    init();
});

async function init() {
    try {
        const {groupId} = await browser.storage.local.get('groupId');
        const {groupsList} = await Utils.sendExternalMessage('get-groups-list');

        groupIcon.src = '';

        groupsSelect.firstElementChild.selected = true;

        while (groupsSelect.firstElementChild.nextElementSibling) {
            groupsSelect.firstElementChild.nextElementSibling.remove();
        }

        for (const group of groupsList) {
            const option = document.createElement('option');

            option.value = group.id;
            option.innerText = group.title;
            option.selected = group.id === groupId;
            option.dataset.iconUrl = group.iconUrl;

            if (option.selected) {
                groupIcon.src = option.dataset.iconUrl;
            }

            groupsSelect.append(option);
        }

        needInstallSTGExtension.classList.remove('showing');
    } catch {
        needInstallSTGExtension.classList.add('showing');
    }

}

init();
