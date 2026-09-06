
import '/js/lang.js?translate-page';
import Listeners from '/js/listeners.js?runtime.onMessage';

// const params = new URLSearchParams(self.location.search);
const autoCloseTimer = self.setTimeout(closeTab, 30_000);

Listeners.runtime.onMessage.add(({action, url}) => {
    if (action === 'real-url') {
        self.clearTimeout(autoCloseTimer);
        self.location.replace(url);
    }
});

async function closeTab() {
    const tab = await browser.tabs.getCurrent();
    await browser.tabs.remove(tab.id);
}
