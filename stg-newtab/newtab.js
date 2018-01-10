if (window.location.search.length) {
    let params = new URLSearchParams(window.location.search),
        url = params.get('url') || 'about:blank',
        title = params.get('title') || 'New tab',
        favIconUrl = params.get('favIconUrl');

    document.getElementById('title').innerText = title || url;

    if (favIconUrl) {
        document.getElementById('favIconUrl').href = favIconUrl;
    }

    window.onfocus = window.onmousemove = () => window.location.href = url;
} else {
    window.location.href = 'about:blank';
}
