
import '/js/lang.js?translate-page';
import Listeners from '/js/listeners.js?runtime.onMessage';
import * as Utils from '/js/utils.js';
import * as Extensions from '/js/extensions.js';

const $ = document.querySelector.bind(document);
const params = new URLSearchParams(self.location.search);

let unsupportedUrl = '';

$('#openNestedUrl').addEventListener('click', openNestedUrl);
$('#copyButton').addEventListener('click', copyUrl);
$('#closeTab').addEventListener('click', closeTab);

if (params.has('url')) {
    showUrl(params.get('url'));

    if (Extensions.isExtensionUrl(unsupportedUrl)) {
        Extensions.onChanged(openExtensionPage);
        openExtensionPage();
    }
} else {
    const autoCloseTimer = self.setTimeout(closeTab, 30_000);

    Listeners.runtime.onMessage.add(({action, url}) => {
        if (action === 'real-url') {
            self.clearTimeout(autoCloseTimer);
            showUrl(url);
        }
    });
}

function showUrl(url) {
    unsupportedUrl = url;

    $('#unsupportedUrlBlock').innerText = document.title = Utils.isUrlLengthValid(url)
        ? url
        : Utils.sliceText(url, 50);

    const nestedUrl = getNestedUrl();

    $('#openNestedUrl').classList.toggle('hidden', !nestedUrl);

    if (nestedUrl) {
        $('#openNestedUrl').focus();
    }
}

// the nested url as the browser opens it, null when it cannot
function getNestedUrl() {
    const nestedUrl = Utils.getNestedUrl(unsupportedUrl);

    return nestedUrl ? Extensions.urlToBrowserOrNull(nestedUrl) : null;
}

async function openExtensionPage() {
    const url = Extensions.urlToBrowserOrNull(unsupportedUrl);

    if (url) {
        await openUrl(url);
    }
}

async function openNestedUrl() {
    const nestedUrl = getNestedUrl();

    if (nestedUrl) {
        await openUrl(nestedUrl);
    }
}

// location.replace to another extension's page is denied, tabs.update is not (docs/CREATE-TABS-BEHAVIOR.md §37, §39, §47)
async function openUrl(url) {
    const tab = await browser.tabs.getCurrent();

    await browser.tabs.update(tab.id, {
        url,
        loadReplace: true,
    });
}

async function copyUrl() {
    await navigator.clipboard.writeText(unsupportedUrl);
}

async function closeTab() {
    const tab = await browser.tabs.getCurrent();
    await browser.tabs.remove(tab.id);
}
