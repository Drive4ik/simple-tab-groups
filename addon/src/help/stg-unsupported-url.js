
import '/js/lang.js?translate-page';
import Listeners from '/js/listeners.js?runtime.onMessage';
import * as Utils from '/js/utils.js';

const $ = document.querySelector.bind(document);
const params = new URLSearchParams(self.location.search);

let unsupportedUrl = '';

$('#copyButton').addEventListener('click', copyUrl);
$('#closeTab').addEventListener('click', closeTab);

if (params.has('url')) {
    showUrl(params.get('url'));
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
}

async function copyUrl() {
    await navigator.clipboard.writeText(unsupportedUrl);
}

async function closeTab() {
    const tab = await browser.tabs.getCurrent();
    await browser.tabs.remove(tab.id);
}
