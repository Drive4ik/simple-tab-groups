const params = new URL(location.href).searchParams;
const name = params.get('probe') ?? '';

document.title = name;
document.getElementById('name').textContent = name;

const describe = value => value === null ? 'null' : value === undefined ? 'undefined' : typeof value === 'object' ? 'window' : typeof value;

async function probe() {
    const report = {probe: name};

    try {
        report.runtimeGetBackgroundPage = describe(await browser.runtime.getBackgroundPage());
    } catch (error) {
        report.runtimeGetBackgroundPage = `rejected: ${error.message}`;
    }

    try {
        report.extensionGetBackgroundPage = describe(browser.extension.getBackgroundPage());
    } catch (error) {
        report.extensionGetBackgroundPage = `threw: ${error.message}`;
    }

    try {
        report.getViewsTabCount = browser.extension.getViews({type: 'tab'}).length;
    } catch (error) {
        report.getViewsTabCount = `threw: ${error.message}`;
    }

    try {
        const tab = await browser.tabs.getCurrent();
        report.cookieStoreId = tab.cookieStoreId;
    } catch (error) {
        report.cookieStoreId = `rejected: ${error.message}`;
    }

    await browser.runtime.sendMessage(report);
}

probe();
