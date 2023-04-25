
import JSON from '/js/json.js';
import * as Utils from '/js/utils.js';

const GISTS_PER_PAGE = 30; // max = 100

const GITHUB_API_URL = 'https://api.github.com';
const GISTS_URL = `${GITHUB_API_URL}/gists`;

const GISTS_GLOBAL_HEADERS = {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
};

async function github(method, url, token, body, headers = {}) {
    method = method.toUpperCase();

    const options = {
        method,
        headers: {
            ...GISTS_GLOBAL_HEADERS,
            ...headers,
            Authorization: `token ${token}`,
        },
    };

    if (method !== 'GET' && body) {
        if (body.files) {
            for (const value of Object.values(body.files)) {
                if (value.content && typeof value.content !== 'string') {
                    value.content = JSON.stringify(value.content, 2);
                }
            }
        }

        options.body = JSON.stringify(body);
    }

    if (Array.isArray(url)) {
        url = Utils.setUrlSearchParams(url[0], url[1]);
    }

    const response = await fetch(url, options);

    if (response.ok) {
        return response.json();
    }

    let message = null;

    if (response.headers.get('content-type')?.includes('json')) {
        ({message} = await response.json());
    } else {
        message = await response.text();
    }

    message = message.slice(0, 150);

    const errorMessage = `GitHub Gist error: ${response.status}: ${response.statusText}\n${message}`;

    console.error(errorMessage);

    throw Error(errorMessage);
}

export default function GithubGist(token, fileName, gistId = null) {
    this.token = token;
    this.fileName = fileName;
    this.gistId = gistId;
}

GithubGist.prototype.checkToken = async function() {
    if (!this.token) {
        throw Error('token is invalid');
    }

    await github('get', [GISTS_URL, {
        page: 1,
        per_page: 1,
    }], this.token);

    return true;
}

GithubGist.prototype.findGistId = async function() {
    return this.gistId = await findGistId(this.token, this.fileName);
}

async function findGistId(token, fileName, page = 1) {
    const gists = await github('get', [GISTS_URL, {
            page,
            per_page: GISTS_PER_PAGE,
        }], token, {
            // cache: 'no-store',
        }),
        gist = gists.find(g => !g.public && g.files.hasOwnProperty(fileName));

    if (gist?.id) {
        return gist.id;
    } else if (gists.length === GISTS_PER_PAGE) {
        if ((page * GISTS_PER_PAGE) > 1000) {
            throw Error('You have too many gists.\nCreate gist and write id in addon options');
        }

        return findGistId(token, fileName, ++page);
    }

    return null;
}

GithubGist.prototype.getGist = async function() {
    const data = await github('get', `${GISTS_URL}/${this.gistId}`, this.token),
        file = data.files[this.fileName];

    if (!file?.content) {
        throw Error('File in gist not found');
    }

    if (file.truncated) {
        file.content = await fetch(file.raw_url).then(res => res.json());
    }

    return {
        content: file.content,
        updated_at: data.updated_at,
    };
}

GithubGist.prototype.createGist = async function(description, content) {
    return github('post', GISTS_URL, this.token, {
        public: false,
        description,
        files: {
            [this.fileName]: {content},
        },
    });
}

GithubGist.prototype.updateGist = async function(content) {
    return github('patch', `${GISTS_URL}/${this.gistId}`, this.token, {
        files: {
            [this.fileName]: {content},
        },
    });
}

GithubGist.prototype.renameGist = async function(newFileName) {
    const result = await github('patch', `${GISTS_URL}/${this.gistId}`, this.token, {
        files: {
            [this.fileName]: {newFileName},
        },
    });

    this.fileName = newFileName;

    return result;
}
