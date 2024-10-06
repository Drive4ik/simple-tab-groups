
import '/js/prefixed-storage.js';
import JSON from '/js/json.js';
import * as Urls from '/js/urls.js';
import * as Utils from '/js/utils.js';

const GISTS_PER_PAGE = 30; // max = 100

const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_USER_URL = `${GITHUB_API_URL}/user`;
const GISTS_URL = `${GITHUB_API_URL}/gists{/gistId}`;

const GISTS_GLOBAL_HEADERS = {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
};

const storage = localStorage.create('github');

function processGistInfo(gist) {
    storage.updated_at = gist.updated_at;
    return gist;
}

export default function GithubGist(token, fileName, gistId = '') {
    this.token = token;
    this.fileName = fileName;
    this.gistId = gistId;
}

GithubGist.prototype.loadUser = async function() {
    return this.request('get', GITHUB_USER_URL);
}

GithubGist.prototype.checkToken = GithubGist.prototype.loadUser;

GithubGist.prototype.findGistId = async function() {
    this.gistId = '';

    const gist = await findGist.call(this);

    if (gist) {
        this.gistId = gist.id;
        processGistInfo(gist);
    }

    return this.gistId;
}

async function findGist(page = 1) {
    const gists = await this.request('get', GISTS_URL, {
            page,
            per_page: GISTS_PER_PAGE,
        }),
        gist = gists.find(g => !g.public && g.files.hasOwnProperty(this.fileName));

    if (gist) {
        return gist;
    }

    if (gists.length === GISTS_PER_PAGE) {
        return findGist.call(this, ++page);
    }

    return null;
}

GithubGist.prototype.getGist = async function(onlyInfo = false) {
    try {
        const gist = await this.request('get', [GISTS_URL, this], undefined, {cache: 'no-store'});

        const file = gist.files[this.fileName];

        if (!file) {
            throw Error('githubNotFoundBackup');
        }

        processGistInfo(gist);

        if (onlyInfo) {
            return gist;
        }

        if (file.truncated) {
            return await this.request('get', file.raw_url, undefined, {cache: 'no-store'});
        }

        delete this.secondTry;

        return JSON.parse(file.content);
    } catch (e) {
        if (e instanceof SyntaxError) {
            throw Error('githubInvalidGistContent');
        }

        if (e.message === 'githubNotFoundBackup') {
            if (!this.secondTry) {
                this.secondTry = true;

                await this.findGistId();

                if (this.gistId) {
                    return this.getGist();
                }
            }

            delete this.secondTry;

            return null;
        }

        throw e;
    }
}

GithubGist.prototype.createGist = async function(content, description = '') {
    const gist = this.request('post', GISTS_URL, {
        public: false,
        description,
        files: {
            [this.fileName]: {content},
        },
    });

    processGistInfo(gist);

    return gist;
}

GithubGist.prototype.updateGist = async function(content) {
    const gist = await this.request('patch', [GISTS_URL, this], {
        files: {
            [this.fileName]: {content},
        },
    });

    processGistInfo(gist);

    return gist;
}

GithubGist.prototype.renameGist = async function(newFileName) {
    const result = await this.request('patch', [GISTS_URL, this], {
        files: {
            [this.fileName]: {newFileName},
        },
    });

    this.fileName = newFileName;

    return result;
}

GithubGist.prototype.request = async function(method, url, body = {}, reqOptions = {}) {
    if (!this.token) {
        throw Error('githubInvalidToken');
    }

    url = Urls.formatUrl(...[url].flat());

    const isApi = url.startsWith(GITHUB_API_URL);

    const options = {
        method: method.toUpperCase(),
        ...reqOptions,
    };

    if (isApi) {
        options.headers ??= {};
        Object.assign(options.headers, GISTS_GLOBAL_HEADERS);
        options.headers.Authorization = `token ${this.token}`;
    }

    let contentLength;

    if (options.method === 'GET') {
        url = Urls.setUrlSearchParams(url, body);
    } else if (body) {
        if (body.files) {
            for (const value of Object.values(body.files)) {
                if (value.content && typeof value.content !== 'string') {
                    value.content = JSON.stringify(value.content, 2);
                }
            }
        }

        // const compressFormat = 'gzip'; // gzip compress, now it doesn't support by github :(
        // const blob = new Blob([JSON.stringify(body)], {type: 'application/json'});
        // const stream = blob.stream();
        // const compressedReadableStream = stream.pipeThrough(new CompressionStream(compressFormat));
        // const compressedResponse = new Response(compressedReadableStream);
        // options.body = await compressedResponse.blob();
        // options.headers['Content-Encoding'] = compressFormat;

        options.body = JSON.stringify(body);

        contentLength = options.body.length + 46_000; // for github api, it doesn't get header content-length
    }

    let response = await fetch(url, options);

    if (isApi) {
        const hasGistAccess = response.headers.get('x-oauth-scopes')?.split(/\s*,\s*/).includes('gist');

        if (!hasGistAccess) {
            throw Error('githubTokenNoAccess');
        }
    }

    if (response.ok) {
        if (this.progressFunc) {
            response = await readBody(response, this.progressFunc, contentLength);
        }

        return response.json();
    }

    if (response.status === 404) {
        throw Error('githubNotFoundBackup');
    } else if (response.status === 401) {
        throw Error('githubInvalidToken');
    }

    const result = await response.json();

    throw Error(`${response.status}: ${result.message}`);
}


async function readBody(response, progressFunc, length = null) {
    length ??= +response.headers.get('content-length');

    const onProgress = received => {
        // for github api, it doesn't get header content-length
        if (length <= 0) {
            length = received * 7;
        }

        if (length < received) {
            length = received;
        }

        const percent = Math.floor(100 * received / length);
        progressFunc(percent);
    };

    const stream = new ReadableStream({
        async start(controller) {
            let receivedLength = 0;

            for await (const chunk of response.body) {
                controller.enqueue(chunk);
                receivedLength += chunk.length;
                onProgress(receivedLength);
            }

            controller.close();
        },
    });

    return new Response(stream, {
        headers: new Headers([...response.headers]),
    });
}
