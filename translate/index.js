(async function() {
    'use strict';

    const USER_NAME = 'Drive4ik',
        REPOSITORY = 'simple-tab-groups',
        LOCALE_FILE_EXT = '.json',
        apiUrlPrefix = `https://api.github.com/repos/${USER_NAME}/${REPOSITORY}/`,
        contentUrlPrefix = `https://raw.githubusercontent.com/${USER_NAME}/${REPOSITORY}/`;

    function notify(body, title = document.title) {
        new window.Notification(title, {
            body: body,
            // icon: contentUrlPrefix + 'master/addon/src/icons/icon.svg',
        });
    }

    async function load(url, defaultValue = {}) {
        let blob = await fetch(url),
            result = await blob.json();

        if (!blob.ok) {
            notify(`GitHub error: ${blob.status} ${blob.statusText}. Please wait a few minutes and try again.\n${result.message}`);
            result = defaultValue;
        }

        return result;
    }

    new Vue({
        el: '#content',
        data: {
            notAllowedKeys: ['branch', 'component', 'locale', 'version', 'polyglot', 'extensionName'],

            branchesLoading: true,
            branches: [],
            branch: 'master',

            manifest: {},

            componentLoading: true,
            components: [{
                name: 'simple-tab-groups-addon',
                path: 'addon/src',
            }],
            componentName: 'simple-tab-groups-addon',

            availableLocalesLoading: false,
            locales: [],
            componentLocale: '',

            defaultLocale: {},
            currentLocale: {},
            showOldValueForKey: null,

            locale: {},
        },

        async mounted() {
            let branches = await load(apiUrlPrefix + 'branches', []);
            this.branches = branches.map(branch => branch.name);
            this.branchesLoading = false;

            this.init();
        },

        computed: {
            pluginsApiUrl() {
                return apiUrlPrefix + `contents/plugins?ref=${this.branch}`;
            },
            localesApiUrl() {
                return apiUrlPrefix + `contents/${this.componentPath}/_locales?ref=${this.branch}`;
            },
            contentUrlPrefix() {
                return contentUrlPrefix + this.branch + '/';
            },
            emailHref() {
                let component = this.componentName || 'unknown component',
                    polyglot = this.locale.polyglot || 'unknown polyglot',
                    locale = this.locale.locale || 'unknown locale';

                return `mailto:drive4ik@gmail.com?subject=[${component}-translation] ${locale} from ${polyglot}`;
            },
            componentPath() {
                let component = this.components.find(comp => comp.name === this.componentName);

                return component ? component.path : 'component-not-found';
            },
            currentLocaleUrl() {
                if (this.locale.locale && this.locale.locale.length > 1) {
                    return this.contentUrlPrefix + this.componentPath + '/_locales/' + this.locale.locale + '/messages' + LOCALE_FILE_EXT;
                }
            },
        },

        watch: {
            branch: 'init',

            componentName(componentName) {
                this.componentLocale = '';

                if (componentName) {
                    this.loadComponentData();
                }
            },

            async componentLocale(componentLocale) {
                if (componentLocale) {
                    this.availableLocalesLoading = true;

                    let locale = await load(this.getLocaleUrl(componentLocale));

                    locale.locale = componentLocale;
                    locale.version = this.manifest.version;
                    locale.component = this.componentName;

                    this.setLocale(locale);

                    this.availableLocalesLoading = false;
                }
            },

            async currentLocaleUrl() {
                this.currentLocale = {};

                if (this.currentLocaleUrl) {
                    try {
                        this.currentLocale = await load(this.currentLocaleUrl);
                    } catch (e) {}
                }
            },
        },

        methods: {
            async init() {
                let plugins = await load(this.pluginsApiUrl, []);
                this.components = [this.components[0]].concat(plugins.filter(element => 'dir' === element.type));

                await this.loadComponentData();
            },
            getLocaleUrl: function(locale) {
                return this.contentUrlPrefix + this.componentPath + '/_locales/' + locale + '/messages' + LOCALE_FILE_EXT;
            },
            async loadComponentData() {
                this.componentLoading = true;
                this.availableLocalesLoading = true;

                this.manifest = await load(this.contentUrlPrefix + this.componentPath + '/manifest.json');
                this.defaultLocale = await load(this.getLocaleUrl(this.manifest.default_locale));

                let locales = await load(this.localesApiUrl, []);
                this.locales = locales.map(lang => lang.name);

                this.componentLoading = false;
                this.availableLocalesLoading = false;
                this.$emit('component-data-loaded');
            },
            setLocale(locale) {
                let localeToSet = {
                    locale: locale.locale,
                    version: locale.version,
                    polyglot: locale.polyglot,
                };

                let mergeAndApplyLocale = function() {
                    Object.keys(this.defaultLocale).forEach(function(key) {
                        if (this.notAllowedKeys.includes(key)) {
                            return;
                        }

                        if (locale[key]) {
                            localeToSet[key] = locale[key].message;
                        }
                    }, this);

                    this.locale = localeToSet;
                }.bind(this);

                if (locale.branch && this.branch !== locale.branch) {
                    this.$once('component-data-loaded', mergeAndApplyLocale);
                    this.branch = locale.branch;
                } else {
                    mergeAndApplyLocale();
                }
            },
            resetValue: function(key) {
                this.locale[key] = this.currentLocale[key].message;

                if (this.showOldValueForKey === key) {
                    this.showOldValueForKey = null;
                }

                this.$forceUpdate();
            },
            onChangeMessage() {
                if (!window.onbeforeunload) {
                    window.onbeforeunload = function() {
                        return 'You really want to close?';
                    };
                }

                this.$forceUpdate();
            },
            async clickLoadLocaleFileButton() {
                let locale = await this.importFromFile();

                this.componentName = locale.component || '';
                this.componentLocale = '';

                this.setLocale(locale);

                if (!this.componentName) {
                    alert('Please, select component of this file');
                }
            },
            clickSaveLocaleFileButton() {
                if (!this.locale.locale) {
                    return alert('Please, enter locale code');
                }

                let localeToSave = {
                        branch: this.branch,
                        component: this.componentName,
                        locale: this.locale.locale,
                        version: this.manifest.version,
                        polyglot: this.locale.polyglot,
                    },
                    fileName = this.componentName + '-translation-' + this.locale.locale + LOCALE_FILE_EXT;

                Object.keys(this.defaultLocale).forEach(function(key) {
                    if (this.notAllowedKeys.includes(key)) {
                        return;
                    }

                    if (!this.locale[key]) {
                        return;
                    }

                    let message = this.locale[key].replace(/\\n/g, '\n');

                    localeToSave[key] = {
                        message: message,
                        description: this.defaultLocale[key].description,
                    };

                    if (this.defaultLocale[key].placeholders) {
                        localeToSave[key].placeholders = this.defaultLocale[key].placeholders;
                    }
                }, this);

                this.exportToFile(localeToSave, fileName);
            },

            importFromFile() {
                return new Promise(function(resolve, reject) {
                    let fileInput = document.createElement('input');

                    fileInput.type = 'file';
                    fileInput.accept = LOCALE_FILE_EXT;
                    fileInput.acceptCharset = 'utf-8';

                    fileInput.initialValue = fileInput.value;
                    fileInput.onchange = readFile;
                    fileInput.click();

                    function readFile() {
                        if (fileInput.value !== fileInput.initialValue) {
                            let file = fileInput.files[0];
                            if (file.size > 100e6) {
                                reject('100MB backup? I don\'t believe you');
                                fileInput.remove();
                                return;
                            }

                            let fReader = new FileReader();
                            fReader.addEventListener('loadend', function(event) {
                                fileInput.remove();
                                try {
                                    resolve(JSON.parse(event.target.result)); // resolve: parsed Object
                                } catch (e) {
                                    reject(e);
                                }
                            });
                            fReader.readAsText(file, 'utf-8');
                        } else {
                            fileInput.remove();
                            reject();
                        }
                    }
                });
            },

            exportToFile(data, fileName) { // data : Object
                let text = JSON.stringify(data, null, '    '),
                    a = document.createElement('a');

                a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
                a.setAttribute('download', fileName);
                a.setAttribute('type', 'application/json');
                a.dispatchEvent(new MouseEvent('click'));
            },

        },
    });

})();
