
import JSON from '/js/json.js';
import * as Utils from '/js/utils.js';

const GISTS_PER_PAGE = 30; // max = 100

const GITHUB_API_URL = 'https://api.github.com';
const GISTS_URL = `${GITHUB_API_URL}/gists`;

const GISTS_GLOBAL_HEADERS = {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
};

export default function GithubGist(token, fileName, gistId = null) {
    this.token = token;
    this.fileName = fileName;
    this.gistId = gistId;
}

GithubGist.prototype.checkToken = async function() {
    await this.request('get', GITHUB_API_URL);
}

GithubGist.prototype.findGistId = async function() {
    this.gistId = null;
    return this.gistId = await findGistId.call(this, this.fileName);
}

async function findGistId(fileName, page = 1) {
    const gists = await this.request('get', GISTS_URL, {
            page,
            per_page: GISTS_PER_PAGE,
        }),
        gist = gists.find(g => !g.public && g.files.hasOwnProperty(fileName));

    if (gist?.id) {
        return gist.id;
    } else if (gists.length === GISTS_PER_PAGE) {
        if ((page * GISTS_PER_PAGE) > 1000) {
            throw Error('You have too many gists.\nCreate gist and write id in addon options'); // TODO move to lang
        }

        return findGistId.call(this, fileName, ++page);
    }

    return null;
}

GithubGist.prototype.getGist = async function() {
    if (!this.gistId) {
        throw Error('githubNotFound');
    }

    const data = await this.request('get', `${GISTS_URL}/${this.gistId}`, undefined, {cache: 'no-store'}),
        file = data.files[this.fileName];

    if (file?.truncated) {
        file.content = await fetch(file.raw_url).then(res => res.json());
    }

    if (!file?.content) {
        throw Error('githubNotFound');
    }

    return {
        content: file.content,
        updated_at: data.updated_at,
    };
}

GithubGist.prototype.createGist = async function(content, description = '') {
    return this.request('post', GISTS_URL, {
        public: false,
        description,
        files: {
            [this.fileName]: {content},
        },
    });
}

GithubGist.prototype.updateGist = async function(content) {
    return this.request('patch', `${GISTS_URL}/${this.gistId}`, {
        files: {
            [this.fileName]: {content},
        },
    });
}

GithubGist.prototype.renameGist = async function(newFileName) {
    const result = await this.request('patch', `${GISTS_URL}/${this.gistId}`, {
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

    method = method.toUpperCase();

    const headers = reqOptions.headers ?? {};
    delete reqOptions.headers;

    const options = {
        method,
        headers: {
            ...GISTS_GLOBAL_HEADERS,
            Authorization: `token ${this.token}`,
            ...headers,
        },
        ...reqOptions,
    };

    if (method === 'GET') {
        url = Utils.setUrlSearchParams(url, body);
    } else if (body) {
        if (body.files) {
            for (const value of Object.values(body.files)) {
                if (value.content && typeof value.content !== 'string') {
                    value.content = JSON.stringify(value.content, 2);
                }
            }
        }

        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    const hasGistAccess = response.headers.get('x-oauth-scopes')?.split(/\s*,\s*/).includes('gist');

    if (!hasGistAccess) {
        throw Error('githubTokenNoAccess');
    }

    if (response.ok) {
        return response.json();
    }

    if (response.status === 404) {
        throw Error('githubNotFound');
    }

    throw Error('githubInvalidToken');

    // TMP
    // let message = null;

    // if (response.headers.get('content-type')?.includes('json')) {
    //     ({message} = await response.json());
    // } else {
    //     message = await response.text();
    // }

    // message = message.slice(0, 150);

    // const errorMessage = `GitHub Gist error: ${response.status} ${response.statusText}\n${message}`;

    // console.error(errorMessage);

    // throw Error(errorMessage);
}
