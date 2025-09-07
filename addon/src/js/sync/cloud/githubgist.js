
import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import * as Urls from '/js/urls.js';

const storage = localStorage.create(Constants.MODULES.CLOUD);

export default class GithubGist {
    #token = null;
    #fileName = null;
    #gistId = null;

    #perPage = null; // max = 100
    #throwOnceUnknownResponse = false;

    progressFunc = null;

    constructor(token, fileName, perPage = 30) {
        if (!token) {
            throw new Error('githubInvalidToken');
        } else if (!fileName) {
            throw new Error('githubInvalidFileName');
        } else if (perPage < 1 || perPage > 100) {
            throw new Error('githubInvalidPerPage');
        }

        this.#token = token;
        this.#fileName = fileName;
        this.#perPage = perPage;
    }

    static apiUrl = 'https://api.github.com';
    static defaultHeaders = {
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
    };

    get #mainUrl() {
        return `${GithubGist.apiUrl}/gists`;
    }

    get #gistUrl() {
        return `${this.#mainUrl}/${this.#gistId}`;
    }

    get hasGist() {
        return this.#gistId !== null;
    }

    #processInfo(gist) {
        storage.lastUpdate = gist.lastUpdate = gist.updated_at;
        return gist;
    }

    async checkToken() {
        try {
            this.#throwOnceUnknownResponse = true;
            await this.#request('POST', this.#mainUrl);
        } catch (e) {
            if (e.status === 422) {
                return true;
            }

            throw e;
        }
    }

    async #findGist() {
        this.#gistId = null;

        const gist = await this.#findGistRecursive();

        if (gist) {
            this.#gistId = gist.id;
            this.#processInfo(gist);
        }
    }

    async #findGistRecursive(page = 1) {
        const gists = await this.#request('GET', this.#mainUrl, {
            page,
            per_page: this.#perPage,
        });

        const gist = gists.find(g => !g.public && g.files[this.#fileName]);

        if (gist) {
            return gist;
        } else if (gists.length === this.#perPage) {
            return this.#findGistRecursive(++page);
        }

        return null;
    }

    async getInfo() {
        this.hasGist || await this.#findGist();

        if (!this.hasGist) {
            throw Error('githubNotFound');
        }

        const gist = await this.#request('GET', this.#gistUrl);

        return this.#processInfo(gist);
    }

    async getContent(withInfo = false) {
        try {
            const gist = await this.getInfo();

            const file = gist.files[this.#fileName];

            const content = file.truncated
                ? await this.#request('GET', file.raw_url)
                : JSON.parse(file.content);

            return withInfo
                ? [content, gist]
                : content;
        } catch (e) {
            if (e instanceof SyntaxError) {
                throw Error('githubInvalidGistContent');
            }

            throw e;
        }
    }

    async setContent(content, description = '') {
        this.hasGist || await this.#findGist();

        const files = {
            [this.#fileName]: {content},
        };

        if (this.hasGist) {
            await this.#request('PATCH', this.#gistUrl, {
                files,
            });
        } else {
            const gist = await this.#request('POST', this.#mainUrl, {
                public: false,
                description,
                files,
            });

            this.#gistId = gist.id;
        }

        // sometimes git make wrong update the field "updated_at" minus 1 second :(
        // thats why we have to get info after update gist
        return await this.getInfo();
    }

    async rename(filename) {
        this.hasGist || await this.#findGist();

        if (!this.hasGist) {
            throw Error('githubNotFound');
        }

        const gist = await this.#request('PATCH', this.#gistUrl, {
            files: {
                [this.#fileName]: {filename},
            },
        });

        this.#fileName = filename;

        return this.#processInfo(gist);
    }

    async #request(method, url, body = {}, options = {}) {
        const throwOnceUnknownResponse = this.#throwOnceUnknownResponse;
        this.#throwOnceUnknownResponse = false;

        if (!this.#token) {
            throw Error('githubInvalidToken');
        }

        body ??= {};
        options.method = method;

        const isApi = url.startsWith(GithubGist.apiUrl);

        if (isApi) {
            options.headers ??= {};
            Object.assign(options.headers, GithubGist.defaultHeaders);
            options.headers.Authorization = `token ${this.#token}`;
        }

        let contentLength;

        if (options.method === 'GET') {
            options.cache ??= 'no-store';
            url = Urls.setUrlSearchParams(url, body);
        } else if (body) {
            if (body.files) {
                for (const value of Object.values(body.files)) {
                    if (value.content && typeof value.content !== 'string') {
                        value.content = JSON.stringify(value.content, null, 2);
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

        if (response.ok) {
            if (this.progressFunc) {
                response = await this.#readBody(response, this.progressFunc, contentLength);
            }

            if (options.method !== 'GET') {
                delete storage.hasError;
            }

            return response.json();
        }

        if (!throwOnceUnknownResponse) {
            storage.hasError = true;
        }

        if (isApi) {
            const classicScopes = response.headers.get('x-oauth-scopes');
            if (classicScopes && !classicScopes.includes('gist')) {
                throw Error('githubTokenNoAccess');
            }

            // const personalScopes = response.headers.get('x-accepted-github-permissions');
            // if (personalScopes && !personalScopes.includes('gists=write')) {
            //     throw Error('githubTokenNoAccess');
            // }
        }

        if (response.status === 401) {
            throw Error('githubInvalidToken');
        }

        if (response.status === 403) {
            if (response.headers.get('x-ratelimit-remaining') === '0') {
                const unix = response.headers.get('x-ratelimit-reset');
                throw new Error(`githubRateLimit:${unix}000`);
            }

            throw Error('githubTokenNoAccess');
        }

        if (response.status === 404) {
            throw Error('githubNotFound');
        }

        if (throwOnceUnknownResponse) {
            throw response;
        }

        const result = await response.json();

        throw Error(`${response.status}: ${result.message}`);
    }

    async #readBody(response, progressFunc, length = null) {
        length ??= +response.headers.get('content-length');

        const onProgress = received => {
            // for github api, it doesn't get header content-length
            if (length <= 0) {
                length = received * 5;
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
}
