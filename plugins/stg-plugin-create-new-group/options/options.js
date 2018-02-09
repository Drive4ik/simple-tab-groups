(async function() {

    let BG = browser.extension.getBackgroundPage();

    let browserActionLabel = document.getElementById('browserActionLabel'),
        browserActionText = document.getElementById('browserActionText'),
        browserActionButton = document.getElementById('browserActionButton');

    browserActionLabel.innerText = browser.i18n.getMessage('enterBrowserActionIconColor');

    let options = await browser.storage.local.get({
        browserActionIconColor: BG.DEFAULT_ICON_COLOR,
    });

    browserActionText.value = options.browserActionIconColor;
    browserActionButton.value = options.browserActionIconColor;

    browserActionText.onchange = function() {
        browserActionButton.value = this.value;
        browserActionButton.onchange();
    };

    browserActionButton.onchange = async function() {
        browserActionText.value = this.value;

        browser.storage.local.set({
            browserActionIconColor: this.value,
        });

        BG.updateBrowserIcon(this.value);
    };

})()
