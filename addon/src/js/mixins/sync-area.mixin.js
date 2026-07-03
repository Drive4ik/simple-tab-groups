
import * as Constants from '/js/constants.js';
import * as Storage from '/js/storage.js';
import * as Utils from '/js/utils.js';
import * as SyncStorage from '/js/sync/sync-storage.js';
import GithubGist from '/js/sync/cloud/githubgist.js';

const gistInfoPromiseCache = new Map();

function gistInfoCacheKey(area) {
    return `${area.options.githubGistToken}\0${area.options.githubGistName}`;
}

export default {
    data() {
        return {
            sync: {
                title: 'syncOptionLocatedFFSync',
                disabled: !SyncStorage.IS_AVAILABLE,
                loadingOptions: false,
                value: Constants.SYNC_STORAGE_FSYNC,
                options: {...Constants.DEFAULT_SYNC_OPTIONS},
                optionsBackup: {},
                load: this.loadSyncOptions.bind(this),
                save: this.saveSyncOptions.bind(this),
                gist: null,
                loadingGist: false,
            },
            local: {
                title: 'syncOptionLocatedLocally',
                disabled: false,
                loadingOptions: false,
                value: Constants.SYNC_STORAGE_LOCAL,
                options: {...Constants.DEFAULT_SYNC_OPTIONS, syncOptionsLocation: Constants.DEFAULT_OPTIONS.syncOptionsLocation},
                optionsBackup: {},
                load: this.loadLocalOptions.bind(this),
                save: this.saveLocalOptions.bind(this),
                gist: null,
                loadingGist: false,
            },
        };
    },
    computed: {
        areas() {
            return [this.sync, this.local];
        },
        area() {
            return this.areas.find(area => area.value === this.local.options.syncOptionsLocation);
        },
    },
    methods: {
        async loadSyncOptions(useCache = true) {
            if (!this.sync.disabled) {
                Object.assign(this.sync.options, await SyncStorage.get());
                this.sync.optionsBackup = {...this.sync.options};
                await this.loadGistInfo(this.sync, useCache);
            }
        },

        async saveSyncOptions() {
            await SyncStorage.set({...this.sync.options});
        },

        async loadLocalOptions(useCache = true) {
            Object.assign(this.local.options, await Storage.get(this.local.options));
            this.local.optionsBackup = {...this.local.options};
            await this.loadGistInfo(this.local, useCache);
        },

        async saveLocalOptions() {
            await Storage.set({...this.local.options});
        },

        formatDate(date, options = {}) {
            return date.toLocaleString(Utils.UI_LANG, {timeStyle: 'short', ...options});
        },

        fetchGistInfo(area, useCache) {
            const key = gistInfoCacheKey(area);

            if (useCache && gistInfoPromiseCache.has(key)) {
                return gistInfoPromiseCache.get(key);
            }

            const promise = new GithubGist(
                area.options.githubGistToken,
                area.options.githubGistFileName,
                area.options.githubGistName
            ).getInfo();

            gistInfoPromiseCache.set(key, promise);

            promise.catch(() => gistInfoPromiseCache.delete(key));

            return promise;
        },

        async loadGistInfo(area, useCache = true) {
            area.gist = null;

            if (!area.options.githubGistToken) {
                return;
            }

            try {
                area.loadingGist = true;

                const gist = await this.fetchGistInfo(area, useCache);

                const history = gist.history.map((item, index) => {
                    delete item.user;

                    item.committed_at_date = new Date(item.committed_at);
                    item.committed_at_relative = Utils.relativeTime(item.committed_at_date);

                    const prevItem = gist.history[index - 1];

                    if (prevItem?.committed_at_relative === item.committed_at_relative) {
                        item.committed_at_time_short = this.formatDate(item.committed_at_date);
                        prevItem.committed_at_time_short ??= this.formatDate(prevItem.committed_at_date);
                    }

                    item.committed_at_full = this.formatDate(item.committed_at_date, {dateStyle: 'full'});
                    item.web_url = `${gist.html_url}/${item.version}`;
                    item.version_short = item.version.slice(0, 5);

                    return item;
                });

                const lastUpdate = new Date(gist.updated_at);

                area.gist = {
                    breadcrumb: [
                        {
                            url: gist.html_url.slice(0, gist.html_url.indexOf(gist.owner.login) + gist.owner.login.length),
                            image: gist.owner.avatar_url,
                            imageLoaded: false,
                            text: gist.owner.login,
                        }, {
                            url: gist.html_url,
                            text: area.options.githubGistName,
                        },
                    ],
                    lastUpdateAgo: Utils.relativeTime(lastUpdate),
                    lastUpdateFull: this.formatDate(lastUpdate, {dateStyle: 'full'}),
                    lastUpdateISO: lastUpdate.toISOString(),
                    history,
                };
            } catch {
            } finally {
                area.loadingGist = false;
            }
        },
    },
}
