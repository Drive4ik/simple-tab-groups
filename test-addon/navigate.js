const params = new URL(location.href).searchParams;
const name = params.get('tab') ?? '';
const to = params.get('to');

document.title = name;
document.getElementById('name').textContent = name;

browser.runtime.onMessage.addListener(message => {
    if (message?.action === 'navigate') {
        location.replace(message.to);
    }
});

if (to) {
    location.replace(to);
}
