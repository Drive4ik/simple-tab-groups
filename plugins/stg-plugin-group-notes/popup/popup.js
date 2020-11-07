(function() {
    'use strict';

    const BG = browser.extension.getBackgroundPage(),
        manifest = browser.runtime.getManifest(),
        isSidebar = '#sidebar' === window.location.hash,
        isTab = '#tab' === window.location.hash;

    (isSidebar || isTab) && document.documentElement.classList.add('fluid');

    let $ = document.querySelector.bind(document),
        $$ = document.querySelectorAll.bind(document),
        rootNode = $('#root'),
        groupTitleNode = $('#groupTitle'),
        groupIconNode = $('#groupIcon'),
        needInstallSTGExtensionNode = $('#needInstallSTGExtension'),
        windowNotHaveGroupNode = $('#windowNotHaveGroup'),
        groupNotesNodes = $$('.group, .notes'),
        easyMDE = new EasyMDE({
            element: $('#group-notes'),
            indentWithTabs: false,
            tabSize: 4,
            status: false,
            toolbar: ['bold', 'italic', 'strikethrough', 'heading', '|', 'horizontal-rule', 'code', 'quote', 'link', 'image', '|', 'unordered-list', 'ordered-list', 'table', '|', 'preview', 'side-by-side', '|', 'guide']
                .filter(bar => isSidebar ? !['guide', 'side-by-side', 'table', 'image', 'horizontal-rule', 'quote'].includes(bar) : true),
            styleSelectedText: false,
            sideBySideFullscreen: false,
            shortcuts: {
                toggleFullScreen: null,
            },
            spellChecker: false,
            placeholder: browser.i18n.getMessage('notesPlaceholder'),
        }),
        previewButtonNode = $('.editor-toolbar button.preview'),
        currentGroupId = null,
        currentWindow = null,
        saveTimer = 0;

    // fix bug with empty statusbar
    easyMDE.gui.statusbar = document.createElement('div');

    function lazySaveCurrentGroupNotes() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveCurrentGroupNotes, 500);
    }

    previewButtonNode.addEventListener('click', e => e.isTrusted && setTimeout(saveCurrentGroupNotes, 50));

    needInstallSTGExtensionNode.href = BG.STG_HOME_PAGE;
    needInstallSTGExtensionNode.innerText = browser.i18n.getMessage('needInstallSTGExtension');
    windowNotHaveGroupNode.innerText = browser.i18n.getMessage('windowNotHaveGroup');

    init().catch(function(e) {
        console.warn(e);
        setGroup('needInstallSTGExtension');
    });

    async function init() {
        let group = await loadCurrentGroup();

        if (group) {
            setGroup(group);

            loadCurrentGroupNotes().then(setGroupNotes);
        } else {
            setGroup('windowNotHaveGroup');
        }
    }

    function setGroup(group) {
        let title = '';

        if (group && group.id) {
            groupTitleNode.innerText = title = browser.i18n.getMessage('groupAndWindowTitle', group.title.replace('⚪', '').trim());
            groupIconNode.src = group.iconUrl;
            currentGroupId = group.id;
        } else {
            title = browser.i18n.getMessage('extensionName') + ' - ' + $('#' + group).innerText;
            currentGroupId = null;
        }

        groupNotesNodes.forEach(function(node) {
            node.style.display = ['needInstallSTGExtension', 'windowNotHaveGroup'].includes(group) ? 'none' : '';
        });
        needInstallSTGExtensionNode.style.display = group === 'needInstallSTGExtension' ? '' : 'none';
        windowNotHaveGroupNode.style.display = group === 'windowNotHaveGroup' ? '' : 'none';

        document.title = title;
    }

    function setGroupNotes({notes, preview}) {
        easyMDE.codemirror.off('change', lazySaveCurrentGroupNotes);

        easyMDE.value(notes);

        if (
            (preview && !easyMDE.isPreviewActive()) ||
            (!preview && easyMDE.isPreviewActive())
        ) {
            easyMDE.togglePreview();
        }

        previewButtonNode.classList.toggle('active', preview);

        easyMDE.codemirror.on('change', lazySaveCurrentGroupNotes);
    }

    async function saveCurrentGroupNotes() {
        if (currentGroupId) {
            let notes = easyMDE.value();

            await browser.storage.local.set({
                [currentGroupId]: {
                    notes,
                    preview: easyMDE.isPreviewActive(),
                },
            });

            BG.setBadge(notes.trim(), currentWindow.id);

            browser.runtime.sendMessage({
                    notesUpdatedForGroupId: currentGroupId,
                })
                .catch(function() {});
        }
    }

    async function loadCurrentGroupNotes() {
        let notes = await browser.storage.local.get({
            [currentGroupId]: {
                notes: '',
                preview: false,
            },
        });

        return notes[currentGroupId];
    }

    async function loadCurrentGroup() {
        let {groupsList} = await BG.sendExternalMessage({
            action: 'get-groups-list',
        });

        currentWindow = await browser.windows.getCurrent();

        return groupsList.find(group => group.windowId === currentWindow.id);
    }

    browser.runtime.onMessage.addListener(function(message, sender) {
        if (sender.id !== manifest.applications.gecko.id) {
            return;
        }

        if (message && message.notesUpdatedForGroupId === currentGroupId) {
            loadCurrentGroupNotes().then(setGroupNotes);
        }
    });

    browser.runtime.onMessageExternal.addListener(async function(request, sender) {
        if (sender.id !== BG.STG_ID) {
            return;
        }

        switch (request.action) {
            case 'i-am-back':
                init();
                break;
            case 'group-loaded':
            case 'group-unloaded':
                currentWindow = await browser.windows.getCurrent();

                if (currentWindow.id === request.windowId) {
                    init();
                }
                break;
            case 'group-updated':
                if (currentGroupId === request.group.id) {
                    setGroup(request.group);
                }
                break;
            case 'group-removed':
                if (currentGroupId === request.groupId) {
                    init();
                }
                break;
        }
    });

    // if isTab
    browser.tabs.getCurrent()
        .then(function(currentTab) {
            currentTab && browser.tabs.onAttached.addListener(tabId => tabId === currentTab.id && init());
        })
        .catch(e => console.error(e));

})()
