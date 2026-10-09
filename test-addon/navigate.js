const params = new URL(location.href).searchParams;
const name = params.get('tab') ?? '';
const to = params.get('to');
const update = params.get('update');

document.title = name;
document.getElementById('name').textContent = name;

const updateSelf = url => browser.tabs.getCurrent()
    .then(tab => browser.tabs.update(tab.id, {url, loadReplace: true}))
    .then(() => ({ok: true}), error => ({ok: false, error: error.message}));

browser.runtime.onMessage.addListener(message => {
    if (message?.action === 'navigate') {
        location.replace(message.to);
    }

    if (message?.action === 'update') {
        return updateSelf(message.to);
    }
});

if (to) {
    location.replace(to);
}

// an accepted update takes the page away before it can say so: only a refusal is reported
if (update) {
    updateSelf(update).then(answer => answer.ok || browser.runtime.sendMessage({navigate: name, error: answer.error}));
}
