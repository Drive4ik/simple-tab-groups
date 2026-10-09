// tells the background who it is, by a message and by a port: the content script the manifest
// declares, in a web page and in the two frames it adds to a scene tab, and the same file loaded
// by a page of the add-on
const ownPage = location.protocol === 'moz-extension:';
const name = new URL(location.href).searchParams.get('tab');
const frame = window === window.top ? 'main frame' : location.href === 'about:blank' ? 'about:blank frame' : 'frame';
const label = ownPage ? 'page of the add-on' : `content script, ${frame}`;

browser.runtime.sendMessage({sender: label}).catch(() => {});
browser.runtime.connect({name: `sender: ${label}`});

if (ownPage) {
    document.title = name ?? '';
} else if (window === window.top && name) {
    for (const src of [location.href, 'about:blank']) {
        const child = document.createElement('iframe');

        child.src = src;
        document.body.append(child);
    }
}
