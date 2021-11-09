
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

let currentTab;

function lang(...args) {
    return browser.i18n.getMessage(...args);
}

function safeHtml(html) {
    let regExp = new RegExp('[' + Object.keys(tagsToReplace).join('') + ']', 'g');
    return (html || '').replace(regExp, tag => tagsToReplace[tag] || tag);
}

function getContainer(cookieStoreId) {
    if (cookieStoreId === TEMPORARY_CONTAINER) {
        return {name: lang('temporaryContainerTitle')};
    } else if (cookieStoreId === DEFAULT_COOKIE_STORE_ID) {
        return {name: lang('noContainerTitle')};
    } else {
        return browser.contextualIdentities.get(cookieStoreId).catch(() => ({name: cookieStoreId, notFound: true}));
    }
}

async function init() {
    const url = urlParams.get('url'),
        anotherCookieStoreId = urlParams.get('anotherCookieStoreId'),
        destCookieStoreId = urlParams.get('destCookieStoreId'),
        originId = urlParams.get('originId'),
        originName = urlParams.get('originName'),
        originIcon = urlParams.get('originIcon'),
        groupId = Number(urlParams.get('groupId')),
        asInfo = urlParams.get('asInfo'),
        group = await loadGroup(groupId),
        currentContainer = await getContainer(destCookieStoreId),
        anotherContainer = await getContainer(anotherCookieStoreId);

    currentTab = await browser.tabs.getCurrent();

    document.title += ' ' + url;

    async function loadGroup(id) {
        let {groups} = await browser.storage.local.get('groups');
        return groups.find(group => group.id === id);
    }

    async function isDepsOk() {
        const tabGroupId = await browser.sessions.getTabValue(currentTab.id, 'groupId'),
            conflictedExtension = await browser.management.get(originId).catch(function() {}),
            group = await loadGroup(groupId),
            anotherContainer = await getContainer(anotherCookieStoreId);

        if (!conflictedExtension?.enabled) {
            openTab(url, destCookieStoreId);
            return;
        } else if (groupId !== tabGroupId) {
            openTab(url);
            return;
        } else if (anotherContainer.notFound) {
            openTab(url, destCookieStoreId);
            return;
        } else if (!group || group.ifDifferentContainerReOpen && group.excludeContainersForReOpen.includes(anotherCookieStoreId)) {
            openTab(url, anotherCookieStoreId);
            return;
        }

        return true;
    }

    if (!asInfo) {
        let isOk = await isDepsOk();

        if (!isOk) {
            return;
        }

        window.onfocus = isDepsOk;

        const onAttachedCallback = (id, {newPosition, newWindowId}) => {
            if (id === currentTab.id) {
                currentTab.index = newPosition;
                currentTab.windowId = newWindowId;
                isDepsOk();
            }
        };

        browser.management.onDisabled.addListener(isDepsOk);
        browser.management.onUninstalled.addListener(isDepsOk);
        browser.tabs.onAttached.addListener(onAttachedCallback);

        window.addEventListener('unload', function() {
            browser.management.onDisabled.removeListener(isDepsOk);
            browser.management.onUninstalled.removeListener(isDepsOk);
            browser.tabs.onAttached.removeListener(onAttachedCallback);
        });
    }

    $('#helpPageOpenInContainerMainTitle')[INNER_HTML] = lang('helpPageOpenInContainerMainTitle', safeHtml(currentContainer.name));
    $('#redirect-url').innerText = url;
    $('#helpPageOpenInContainerDesc1')[INNER_HTML] = lang('helpPageOpenInContainerDesc1', [safeHtml(group.title), safeHtml(currentContainer.name)]);
    $('#another-addon-img').src = originIcon;
    $('#another-addon-name').innerText = originName;
    $('#helpPageOpenInContainerDesc3')[INNER_HTML] = lang('helpPageOpenInContainerDesc3', [safeHtml(anotherContainer.name), safeHtml(originName)]);

    // load favicon
    $('#redirect-img').src = 'https://www.google.com/s2/favicons?sz=16&domain_url=' + encodeURIComponent(new URL(url).origin);

    if (asInfo) {
        $('main').classList.add('as-info');
        return;
    }

    $('#deny')[INNER_HTML] = lang('helpPageOpenInContainerOpenInContainer', safeHtml(anotherContainer.name));
    $('#confirm')[INNER_HTML] = lang('helpPageOpenInContainerOpenInContainer', safeHtml(currentContainer.name));

    $('#helpPageOpenInContainerExcludeContainerToGroup')[INNER_HTML] = lang('helpPageOpenInContainerExcludeContainerToGroup', [safeHtml(anotherContainer.name), safeHtml(group.title)]);

    $('#helpPageOpenInContainerIgnoreAppForSession')[INNER_HTML] = lang('helpPageOpenInContainerIgnoreAppForSession', safeHtml(originName));

    $('#deny').addEventListener('click', () => openTab(url, anotherCookieStoreId, 'deny', groupId));
    $('#confirm').addEventListener('click', () => openTab(url, destCookieStoreId, 'confirm', undefined, originId));
    $('#exclude-container').addEventListener('change', e => {
        $('#confirm').disabled = e.target.checked;

        if (e.target.checked) {
            $('#ignore-origin-id-for-session').checked = $('#deny').disabled = false;
        }
    });
    $('#ignore-origin-id-for-session').addEventListener('change', e => {
        $('#deny').disabled = e.target.checked;

        if (e.target.checked) {
            $('#exclude-container').checked = $('#confirm').disabled = false;
        }
    });
}

async function openTab(url, cookieStoreId = DEFAULT_COOKIE_STORE_ID, buttonId = null, groupId = null, originId = null) {
    try {
        if (buttonId === 'deny' && $('#exclude-container').checked) {
            let result = await browser.runtime.sendMessage({
                action: 'exclude-container-for-group',
                cookieStoreId,
                groupId,
            });

            if (!result) {
                throw Error('unknown error');
            } else if (!result.ok) {
                throw Error(result.error);
            }
        }

        if (buttonId === 'confirm' && $('#ignore-origin-id-for-session').checked) {
            let result = await browser.runtime.sendMessage({
                action: 'ignore-ext-for-reopen-container',
                id: originId,
            });

            if (!result) {
                throw Error('unknown error');
            } else if (!result.ok) {
                throw Error(result.error);
            }
        }

        if (currentTab.cookieStoreId === cookieStoreId) {
            browser.tabs.update(currentTab.id, {
                loadReplace: true,
                url,
            });
        } else {
            await browser.tabs.create({
                url,
                active: true,
                index: currentTab.index,
                windowId: currentTab.windowId,
                cookieStoreId,
            });

            browser.tabs.remove(currentTab.id);
        }
    } catch (e) {
        if (buttonId) {
            $('#' + buttonId).disabled = true;
        }
        alert(e);
    }
}

init();
