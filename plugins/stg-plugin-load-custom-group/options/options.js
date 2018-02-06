(async function() {
    'use strict';

    let $ = document.querySelector.bind(document),
        bg = browser.extension.getBackgroundPage(),
        groupsSelect = $('#groups-select'),
        selectGroupHeader = $('#select-group-header');

    selectGroupHeader.innerText = browser.i18n.getMessage('needSelectGroup');

    try {
        await init();
    } catch (e) {
        let a = document.createElement('a');
        a.innerText = browser.i18n.getMessage('needInstallSTGExtension').replace(/\n+/, '\n');
        a.id = 'notificationInstallSTG';
        a.href = bg.STG_HOME_PAGE;
        a.target = '_blank';
        selectGroupHeader.parentNode.insertBefore(a, selectGroupHeader);
        return;
    }

    groupsSelect.addEventListener('change', async function() {
        let groupId = parseInt(groupsSelect.value, 10);

        if (groupsSelect.children[0].dataset.isEmpty) {
            groupsSelect.children[0].remove();
        }

        await browser.storage.local.set({
            groupId: groupId,
        });

        bg.updateBrowserAction(groupId);
    });

    browser.runtime.onMessageExternal.addListener(function(request, sender, sendResponse) {
        if (sender.id !== bg.STG_ID) {
            return;
        }

        if (request.groupUpdated || request.groupDeleted || request.groupAdded) {
            init();
        }
    });

    async function init() {
        let { groupId } = await browser.storage.local.get('groupId'),
            { groupsList } = await bg.sendExternalMessage({
                getGroupsList: true,
            });

        while (groupsSelect.firstElementChild) {
            groupsSelect.firstElementChild.remove();
        }

        let notificationInstallSTG = $('#notificationInstallSTG');
        if (notificationInstallSTG) {
            notificationInstallSTG.remove();
        }

        let foundSelected = false;

        groupsList.forEach(function(group) {
            let option = document.createElement('option');

            option.value = group.id;
            option.innerText = group.title;

            if (group.id === groupId) {
                foundSelected = true;
                option.selected = true;
            }

            groupsSelect.append(option);
        });

        if (!foundSelected) {
            let emptyOption = document.createElement('option');
            emptyOption.innerText = browser.i18n.getMessage('needSelectGroup');
            emptyOption.selected = true;
            emptyOption.dataset.isEmpty = true;
            groupsSelect.prepend(emptyOption);
        }
    }

})()
