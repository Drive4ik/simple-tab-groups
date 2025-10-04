
import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import * as Urls from '/js/urls.js';
import * as Utils from '/js/utils.js';

const storage = localStorage.create(Constants.MODULES.CLOUD);

export default class GithubGist {
    #token = null;
    #fileName = null;
    #gistId = null;

    #perPage = null; // max = 100
    #throwOnceUnknownResponse = false;

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

    async getInfo(revision = null, progressFunc = null) {
        this.hasGist || await this.#findGist();

        if (!this.hasGist) {
            throw Error('githubNotFound');
        }

        let gistUrl = this.#gistUrl;

        if (revision) {
            gistUrl += `/${revision}`;
        }

        const gist = await this.#request('GET', gistUrl, undefined, undefined, progressFunc);

        return this.#processInfo(gist);
    }

    async getContent(revision, withInfo = false, progressFunc = null) {
        try {
            const progressApiFunc = this.#createProgress(0, 50, progressFunc);
            const progressRawFunc = this.#createProgress(50, 100, progressFunc);

            const gist = await this.getInfo(revision, progressApiFunc);

            const file = gist.files[this.#fileName];

            let content;

            if (file.truncated) {
                content = await this.#request('GET', file.raw_url, undefined, undefined, progressRawFunc);
            } else {
                content = JSON.parse(file.content);
                progressRawFunc(100);
            }

            return withInfo ? [content, gist] : content;
        } catch (e) {
            if (e instanceof SyntaxError) {
                throw Error('githubInvalidGistContent');
            }

            throw e;
        }
    }

    async setContent(content, description = '', progressFunc = null) {
        this.hasGist || await this.#findGist();

        const files = {
            [this.#fileName]: {content},
        };

        const progressSend = this.#createProgress(0, 70, progressFunc);
        const progressGet = this.#createProgress(70, 100, progressFunc);

        if (this.hasGist) {
            await this.#request('PATCH', this.#gistUrl, {
                files,
            }, undefined, progressSend);
        } else {
            const gist = await this.#request('POST', this.#mainUrl, {
                public: false,
                description,
                files,
            }, undefined, progressSend);

            this.#gistId = gist.id;
        }

        // sometimes git make wrong update the field "updated_at" minus 1 second :(
        // thats why we have to get info after update gist
        return await this.getInfo(undefined, progressGet);
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

    async #request(method, url, body = null, options = {}, progressFunc = null) {
        const throwOnceUnknownResponse = this.#throwOnceUnknownResponse;
        this.#throwOnceUnknownResponse = false;

        if (!this.#token) {
            throw Error('githubInvalidToken');
        }

        const isApi = url.startsWith(GithubGist.apiUrl);

        options.method = method;
        options.headers ??= {};

        if (isApi) {
            Object.assign(options.headers, GithubGist.defaultHeaders);
            options.headers.Authorization = `token ${this.#token}`;
        }

        if (options.method === 'GET') {
            url = Urls.setUrlSearchParams(url, body ?? {});
            options.cache ??= 'no-store';
        } else if (body) {
            if (body.files) {
                for (const file of Object.values(body.files)) {
                    if (file.content && typeof file.content !== 'string') {
                        file.content = JSON.stringify(file.content, null, 2);
                    }
                }
            }

            options.body = JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
        }

        const response = await this.#progressFetch(url, options, progressFunc);

        if (response.ok) {
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

    #createProgress(currentProgress, progressDuration, progressFunc = null) {
        return progress => this.#callProgress(currentProgress, progressDuration, progress, progressFunc);
    }

    #callProgress(currentProgress, progressDuration, progress, progressFunc = null) {
        const durationPart = (progressDuration - currentProgress) / 100;
        const mainPercent = currentProgress + Math.floor(progress * durationPart);
        progressFunc?.(mainPercent);
    }

    async #progressFetch(url, options, progressFunc = null) {
        const cacheUrlKey = await Utils.sha256Hex([this.#fileName, options.method, url].join(''));
        const cache = storage.create('cache').create(cacheUrlKey.slice(0, 5));

        if (options.method === 'GET') {
            const response = await fetch(url, options);

            const stream = new ReadableStream({
                start: async controller => {
                    let length = +response.headers.get('content-length') || cache.responseLength || 0;
                    let received = 0;

                    for await (const chunk of response.body) {
                        controller.enqueue(chunk);

                        received += chunk.length;

                        if (length <= 0) {
                            length = received * 7;
                        } else if (length < received) {
                            length = received;
                        }

                        const percent = Math.floor(received / length * 100);
                        this.#callProgress(0, 100, percent, progressFunc);
                    }

                    if (response.ok) {
                        cache.responseLength = length;
                    }

                    controller.close();
                },
            });

            return new Response(stream, response);
        } else { // POST, PATCH, ...
            // use XMLHttpRequest for upload progress
            // because fetch doesn't support upload progress now :(
            // https://developer.mozilla.org/en-US/docs/Web/API/Request/body

            const createXHRProgess = (currentProgress, progressDuration) => {
                let total;
                return event => {
                    total ??= event.lengthComputable
                        ? event.total
                        : (event.target instanceof XMLHttpRequest ? (cache.responseLength || 0) : null);

                    if (total <= 0) {
                        total = event.loaded * 7;
                    } else if (total < event.loaded) {
                        total = event.loaded;
                    }

                    const xhrProgress = Math.floor(event.loaded / total * 100);
                    this.#callProgress(currentProgress, progressDuration, xhrProgress, progressFunc);
                };
            }

            const xhr = await new Promise(resolve => {
                const xhr = new XMLHttpRequest();

                xhr.open(options.method, url, true);

                for (const [key, value] of Object.entries(options.headers)) {
                    xhr.setRequestHeader(key, value);
                }

                xhr.upload.onprogress = createXHRProgess(0, 70);
                xhr.onprogress = createXHRProgess(70, 100);
                xhr.onload = xhr.onerror = xhr.onabort = () => resolve(xhr);

                xhr.send(options.body);
            });

            if (xhr.status >= 200 && xhr.status < 204) {
                cache.responseLength = xhr.responseText.length;
            }

            const headers = xhr.getAllResponseHeaders().trim().split(/[\r\n]+/).map(header => header.split(': '));

            return new Response(xhr.responseText, {
                status: xhr.status,
                statusText: xhr.statusText,
                headers: new Headers(headers),
            });
        }
    }

    /* createProgressBody(bodyStr, progressFunc) {
        // options.duplex = 'half'; // TODO: not supported by firefox now :(
        // https://developer.mozilla.org/en-US/docs/Web/API/Request/duplex

        const jsonBytes = new TextEncoder().encode(bodyStr); // Uint8Array
        const length = jsonBytes.byteLength;
        let uploaded = 0;

        const onProgress = uploaded => {
            const percent = Math.floor(uploaded / length * 100);
            progressFunc(percent);
        };

        const readableStream = new ReadableStream({
            start(controller) {
                const chunkSize = 1024 * 256; // 256 KB
                for (let i = 0; i < length; i += chunkSize) {
                    controller.enqueue(jsonBytes.slice(i, i + chunkSize));
                }
                controller.close();
            }
        });

        const transformStream = new TransformStream({
            transform(chunk, controller) { // chunk is Uint8Array
                uploaded += chunk.byteLength;
                onProgress(uploaded);
                controller.enqueue(chunk);
            }
        });

        return readableStream.pipeThrough(transformStream);
    } */
}



// const compressFormat = 'gzip'; // gzip compress, now it doesn't support by github :(
// const blob = new Blob([bodyStr], {type: 'application/json'});
// const stream = blob.stream();
// const compressedReadableStream = stream.pipeThrough(new CompressionStream(compressFormat));
// const compressedResponse = new Response(compressedReadableStream);
// options.body = await compressedResponse.blob();
// options.headers['Content-Encoding'] = compressFormat;
