(async function() {
    'use strict';

    let $ = document.querySelector.bind(document),
        BG = browser.extension.getBackgroundPage(),
        groupsSelect = $('#groups-select'),
        selectGroupHeader = $('#select-group-header');

    selectGroupHeader.innerText = browser.i18n.getMessage('needSelectGroup');

    try {
        await init();
    } catch (e) {
        let a = document.createElement('a');
        a.innerText = browser.i18n.getMessage('needInstallSTGExtension').replace(/\n+/, '\n');
        a.id = 'notificationInstallSTG';
        a.href = BG.STG_HOME_PAGE;
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

        BG.updateBrowserAction();
    });

    browser.runtime.onMessageExternal.addListener(function(request, sender, sendResponse) {
        if (sender.id !== BG.STG_ID) {
            return;
        }

        switch (request.action) {
            case 'group-added':
            case 'group-updated':
            case 'group-removed':
                init();
                break;
        }
    });

    async function init() {
        let { groupId } = await browser.storage.local.get('groupId'),
            { groupsList } = await BG.sendExternalMessage({
                action: 'get-groups-list',
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
