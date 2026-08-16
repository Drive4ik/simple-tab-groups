const status = document.getElementById('status');

async function refresh() {
    const has = await browser.permissions.contains({permissions: ['bookmarks']});
    status.textContent = has ? 'bookmarks permission: granted' : 'bookmarks permission: not granted';
}

document.getElementById('grant').addEventListener('click', async () => {
    const granted = await browser.permissions.request({permissions: ['bookmarks']});
    status.textContent = granted
        ? 'granted — go back to the console'
        : 'declined — click again and allow, or answer the question with what happened';
});

refresh();
