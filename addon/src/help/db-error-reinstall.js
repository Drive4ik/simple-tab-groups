
import '/js/lang.js?translate-page';

document.getElementById('open-firefox-downloads-folder').addEventListener('click', function() {
    browser.downloads.showDefaultFolder();
});
