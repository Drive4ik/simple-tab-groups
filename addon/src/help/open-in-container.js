
const INNER_HTML = 'innerHTML',
    $ = window.document.querySelector.bind(window.document),
    tagsToReplace = {
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
        '&': '&amp;',
    },
    urlParams = new URLSearchParams(window.location.search);

function lang(...args) {
    return browser.i18n.getMessage(...args);
}

function safeHtml(html) {
    let regExp = new RegExp('[' + Object.keys(tagsToReplace).join('') + ']', 'g');
    return (html || '').replace(regExp, tag => tagsToReplace[tag] || tag);
}

function createFavIconNode(url) {
    const imageElement = document.createElement('img');

    imageElement.src = url;
    imageElement.addEventListener('error', e => imageElement.src = '/icons/tab.svg');

    return imageElement;
}

function addFavicon(url) {
    const origin = new URL(url).origin;

    $('#redirect-url').prepend(createFavIconNode(`${origin}/favicon.ico`));
}

async function init() {
    const url = urlParams.get('url'),
        currentCookieStoreId = urlParams.get('currentCookieStoreId'),
        anotherCookieStoreId = urlParams.get('anotherCookieStoreId'),
        uuid = urlParams.get('uuid'),
        groupId = Number(urlParams.get('groupId')),
        [{groups}, currentContainer, anotherContainer] = await Promise.all([
            browser.storage.local.get('groups'),
            TEMPORARY_CONTAINER === currentCookieStoreId
                ? {name: lang('temporaryContainerTitle')}
                : browser.contextualIdentities.get(currentCookieStoreId).catch(() => ({name: currentCookieStoreId, notFound: true})),
            DEFAULT_COOKIE_STORE_ID === anotherCookieStoreId
                ? {name: 'Default'}
                : browser.contextualIdentities.get(anotherCookieStoreId).catch(() => ({name: anotherCookieStoreId, notFound: true})),
        ]),
        group = groups.find(group => group.id === groupId);

    document.title += ' ' + url;

    async function checkTabGroup() {
        const {id} = await browser.tabs.getCurrent(),
            tabGroupId = await browser.sessions.getTabValue(id, 'groupId');

        if (groupId === tabGroupId) {
            return true;
        }

        openTab(url);
    }

    let isValidGroup = await checkTabGroup();

    if (!isValidGroup) {
        return;
    } else if (anotherContainer.notFound && currentContainer.notFound) {
        openTab(url);
        return;
    } else if (anotherContainer.notFound) {
        $('#deny').disabled = true;
    } else if (currentContainer.notFound) {
        $('#confirm').disabled = true;
    }

    window.onfocus = checkTabGroup;

    $('#helpPageOpenInContainerMainTitle')[INNER_HTML] = lang('helpPageOpenInContainerMainTitle', safeHtml(currentContainer.name));
    $('#redirect-url').innerText = url;
    $('#helpPageOpenInContainerDesc1')[INNER_HTML] = lang('helpPageOpenInContainerDesc1', [safeHtml(group.title), safeHtml(currentContainer.name)]);
    $('#addon-known-content').innerText = uuid;
    $('#helpPageOpenInContainerDesc3')[INNER_HTML] = lang('helpPageOpenInContainerDesc3', [safeHtml(anotherContainer.name), safeHtml(uuid)]);

    $('#deny')[INNER_HTML] = lang('helpPageOpenInContainerOpenInContainer', safeHtml(anotherContainer.name));
    $('#confirm')[INNER_HTML] = lang('helpPageOpenInContainerOpenInContainer', safeHtml(currentContainer.name));

    addFavicon(url);

    $('#deny').addEventListener('click', () => openTab(url, anotherCookieStoreId, 'deny'));
    $('#confirm').addEventListener('click', () => openTab(url, currentCookieStoreId, 'confirm'));
}

async function openTab(url, cookieStoreId = DEFAULT_COOKIE_STORE_ID, buttonId = null) {
    try {
        const {id, index} = await browser.tabs.getCurrent();

        await browser.tabs.create({
            url,
            active: true,
            index,
            cookieStoreId,
        });

        browser.tabs.remove(id);
    } catch (e) {
        if (buttonId) {
            $(`#{buttonId}`).disabled = true;
        }
        alert(e);
    }
}

init();

