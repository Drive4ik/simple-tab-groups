
import './translate-help-pages.js';

const $ = document.querySelector.bind(document);
const UNSUPPORTED_URL = location.hash.slice(1).trim();

$('#unsupportedUrlBlock').innerText = UNSUPPORTED_URL;
$('#copyButton').addEventListener('click', () => navigator.clipboard.writeText(UNSUPPORTED_URL));
$('#closeTab').addEventListener('click', closeTab);

if (UNSUPPORTED_URL) {
    document.title = UNSUPPORTED_URL;
} else {
    closeTab();
}

async function closeTab() {
    let tab = await browser.tabs.getCurrent();
    await browser.tabs.remove(tab.id);
}
