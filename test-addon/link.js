const params = new URL(location.href).searchParams;
const name = params.get('tab') ?? '';
const to = params.get('to') ?? '';

document.title = name;
document.getElementById('name').textContent = name;

const link = document.getElementById('link');

link.href = to;
link.textContent = to;

browser.runtime.onMessage.addListener(message => {
    if (message?.action === 'open') {
        return Promise.resolve({opened: window.open(message.to, '_blank') !== null});
    }
});
