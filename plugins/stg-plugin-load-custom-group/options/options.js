
let $ = document.querySelector.bind(document),
    bg = browser.extension.getBackgroundPage(),
    groupsSelect = $('#groups-select');

$('#select-group-header').innerText = browser.i18n.getMessage('needSelectGroup');

groupsSelect.addEventListener('change', async function() {
    let groupId = parseInt(this.value, 10);

    await browser.storage.local.set({
        groupId: groupId,
    });

    bg.updateBrowserAction(groupId);
});

Promise.all([
        browser.storage.local.get('groupId'),
        bg.sendExternalMessage({
            getGroupsList: true,
        })
    ])
    .then(function([{ groupId }, { groupsList }]) {
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
            emptyOption.disabled = true;
            groupsSelect.prepend(emptyOption);
        }
    });

