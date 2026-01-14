import '/translate-page.js';
import '/easymde/easymde.min.js';
import * as Constants from '/constants.js';
import * as MainConstants from '/main-constants.js';
import * as Utils from '/utils.js';
import * as MainUtils from '/main-utils.js';

const isSidebar = self.location.hash === '#sidebar';
const isTab = self.location.hash === '#tab';

document.documentElement.classList.toggle('fluid', isSidebar || isTab);

if (!isSidebar && !isTab) {
    // fix bug a lot of window resize event, which makes it impossible to select text on preview side-by-side. Replicate only on popup ¯\_(ツ)_/¯
    window.addEventListener('resize', e => e.stopImmediatePropagation(), true);
}

const options = await browser.storage.local.get(MainConstants.defaultOptions);

const $ = document.querySelector.bind(document),
    groupTitleNode = $('#groupTitle'),
    groupIconNode = $('#groupIcon'),
    tabFavicon = $('head link[rel~="icon"]'),
    DEFAULT_FAVICON_HREF = tabFavicon.href,
    needInstallSTGExtensionNode = $('#needInstallSTGExtension'),
    windowNotHaveGroupNode = $('#windowNotHaveGroup'),
    easyMDE = new EasyMDE({
        element: $('#group-notes'),
        indentWithTabs: false,
        autoDownloadFontAwesome: false,
        lineNumbers: options.editorLineNumbers,
        lineWrapping: options.editorLineWrapping,
        promptURLs: options.editorPromptUrls,
        previewImagesInEditor: options.editorPreviewImages,
        direction: options.editorUseRTLDirection ? 'rtl' : 'ltr',
        autofocus: true,
        status: false,
        uploadImage: true,
        imageUploadFunction(file, onSuccess, onError) {
            const reader = new FileReader();
            reader.addEventListener('load', () => onSuccess(reader.result));
            reader.addEventListener('error', onError);
            reader.addEventListener('abort', onError);
            reader.readAsDataURL(file);
        },
        toolbar: ['bold', 'italic', 'strikethrough', 'heading', '|', 'horizontal-rule', 'code', 'quote', 'link', 'image', 'upload-image', '|', 'unordered-list', 'ordered-list', 'table', '|', 'preview', 'side-by-side', '|', 'guide'],
        hideIcons: isSidebar
            ? ['guide', 'side-by-side', 'table', 'heading', 'horizontal-rule', 'quote']
            : (isTab ? [] : ['upload-image']),
        styleSelectedText: false,
        sideBySideFullscreen: false,
        shortcuts: {
            toggleFullScreen: null,
        },
        spellChecker: false,
        placeholder: browser.i18n.getMessage('notesPlaceholder'),
    }),
    previewButtonNode = $('.editor-toolbar button.preview'),
    sideBySideButtonNode = isSidebar ? null : $('.editor-toolbar button.side-by-side');

let currentGroupId = null,
    currentWindow = null,
    saveTimer = 0;

if (!isSidebar) {
    sideBySideButtonNode.addEventListener('click', e => e.isTrusted && setTimeout(saveCurrentGroupNotes, 50));
}
previewButtonNode.addEventListener('click', e => e.isTrusted && setTimeout(saveCurrentGroupNotes, 50));

needInstallSTGExtensionNode.href = Constants.STG_HOME_PAGE;
if (isTab) {
    $('#openInTab').remove();
} else {
    $('#openInTab').addEventListener('click', MainUtils.openInTab);
}
$('#openOptions').addEventListener('click', () => browser.runtime.openOptionsPage());

if (isTab) {
    const currentTab = await browser.tabs.getCurrent().catch(() => {});
    if (currentTab) {
        browser.tabs.onAttached.addListener(tabId => tabId === currentTab.id && init());
    }
}

init();

async function init() {
    try {
        currentWindow = await browser.windows.getCurrent();

        const group = await loadCurrentGroup();

        if (group) {
            setGroup(group);

            loadCurrentGroupNotes().then(setGroupNotes);
        } else {
            setGroup(null, 'windowNotHaveGroup');
        }
    } catch (e) {
        console.error(e);
        setGroup(null, 'needInstallSTGExtension');
    }
}

function setGroup(group = null, idErrorMessage = null) {
    let tabTitle;

    if (group) {
        tabTitle = groupTitleNode.innerText = browser.i18n.getMessage('groupAndWindowTitle', group.title);
        groupIconNode.src = group.iconUrl;
        if (isTab && options.tabFaviconAsGroup) {
            tabFavicon.href = group.iconUrl;
        }
        currentGroupId = group.id;
    } else {
        tabTitle = browser.i18n.getMessage('extensionName') + ' - ' + $('#' + idErrorMessage).innerText;
        if (isTab && options.tabFaviconAsGroup) {
            tabFavicon.href = DEFAULT_FAVICON_HREF;
        }
        currentGroupId = null;
    }

    if (isTab) {
        document.title = tabTitle;
    }

    needInstallSTGExtensionNode.classList.toggle('hidden', idErrorMessage !== 'needInstallSTGExtension');
    windowNotHaveGroupNode.classList.toggle('hidden', idErrorMessage !== 'windowNotHaveGroup');
}

function lazySaveCurrentGroupNotes() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrentGroupNotes, 500);
}

function setGroupNotes({notes, preview, sideBySide = false}) {
    easyMDE.codemirror.off('change', lazySaveCurrentGroupNotes);

    easyMDE.value(notes);

    if (
        (sideBySide && !easyMDE.isSideBySideActive()) ||
        (!sideBySide && easyMDE.isSideBySideActive())
    ) {
        easyMDE.toggleSideBySide();
    } else if (
        (preview && !easyMDE.isPreviewActive()) ||
        (!preview && easyMDE.isPreviewActive())
    ) {
        easyMDE.togglePreview();
    }

    if (!isSidebar) {
        sideBySideButtonNode.classList.toggle('active', sideBySide);
    }
    previewButtonNode.classList.toggle('active', preview);

    easyMDE.codemirror.on('change', lazySaveCurrentGroupNotes);
}

async function saveCurrentGroupNotes() {
    if (currentGroupId) {
        const groupKey = MainUtils.getGroupKey(currentGroupId);
        const notes = easyMDE.value();

        await browser.storage.local.set({
            [groupKey]: {
                notes,
                preview: easyMDE.isPreviewActive(),
                sideBySide: easyMDE.isSideBySideActive(),
            },
        });

        MainUtils.setBadge(notes.trim().length > 0, currentWindow.id);

        Utils.sendMessage('notes-updated', {currentGroupId}).catch(() => {});
    }
}

async function loadCurrentGroupNotes() {
    const groupKey = MainUtils.getGroupKey(currentGroupId);
    const notes = await browser.storage.local.get({
        [groupKey]: {
            notes: '',
            preview: false,
            sideBySide: false,
        },
    });

    return notes[groupKey];
}

async function loadCurrentGroup() {
    const {groupsList} = await Utils.sendExternalMessage('get-groups-list');

    return groupsList?.find(group => group.windowId === currentWindow.id);
}

browser.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== browser.runtime.id) {
        return;
    }

    switch (message.action) {
        case 'notes-updated':
            if (message.currentGroupId === currentGroupId) {
                loadCurrentGroupNotes().then(setGroupNotes);
            }
            break;
        case 'options-updated':
            self.location.reload();
            break;
    }
});

browser.runtime.onMessageExternal.addListener(async (request, sender) => {
    if (sender.id !== Constants.STG_ID) {
        return;
    }

    switch (request.action) {
        case 'i-am-back':
            init();
            break;
        case 'group-loaded':
        case 'group-unloaded':
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
