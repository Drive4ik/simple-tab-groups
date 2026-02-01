
import '/js/lang.js?translate-page';

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
    window.close();
}
