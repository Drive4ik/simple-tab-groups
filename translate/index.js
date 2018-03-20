(async function() {
    'use strict';

    window.onbeforeunload = function() {
        return 'You really want to close?';
    };

    const BRANCH = 'master',
        LOCALE_FILE_EXT = '.json',
        urlPrefix = `https://raw.githubusercontent.com/Drive4ik/simple-tab-groups/${BRANCH}/`,
        htmlApiPrefix = `https://github.com/Drive4ik/simple-tab-groups/tree/${BRANCH}/`,
        pluginsApiUrl = `https://api.github.com/repos/Drive4ik/simple-tab-groups/contents/plugins?ref=${BRANCH}`;

    async function load(url) {
        let blob = await fetch(url);
        return blob.json();
    }

    let plugins = await load(pluginsApiUrl);

    new Vue({
        el: '#content',
        data: {
            loading: true,

            notAllowedKeys: ['component', 'locale', 'version', 'polyglot', 'extensionName'],

            manifest: {},

            components: [
                {
                    name: 'simple-tab-groups-addon',
                    path: 'addon',
                }
            ].concat(plugins.filter(p => 'dir' === p.type)),
            selectedComponentName: null,

            defaultLocale: {},

            currentLocale: {},
            showOldValueByKey: null,

            locale: {},
        },

        async mounted() {
            this.selectedComponentName = this.components[0].name;
        },

        computed: {
            emailHref() {
                let component = this.selectedComponentName || 'unknown component',
                    polyglot = this.locale.polyglot || 'unknown polyglot',
                    locale = this.locale.locale || 'unknown locale';

                return `mailto:drive4ik@gmail.com?subject=[${component}-translation] ${locale} from ${polyglot}`;
            },
            localesFolder() {
                return htmlApiPrefix + this.selectedComponentPath + '/_locales';
            },
            selectedComponentPath() {
                let component = this.components.find(c => c.name === this.selectedComponentName);
                return component ? component.path : null;
            },
        },

        watch: {
            selectedComponentName: function(selectedComponentName) {
                if (selectedComponentName) {
                    this.loadLocaleFromSelectedComponent();
                }
            },

            'locale.locale': async function(locale) {
                this.currentLocale = {};

                if (locale.length > 1) {
                    try {
                        this.currentLocale = await load(this.getLocaleUrl(locale));
                    } catch (e) {
                        if (locale.includes('_')) {
                            try {
                                this.currentLocale = await load(this.getLocaleUrl(locale.split('_').shift().toLowerCase()));
                            } catch (e) {}
                        }
                    }
                }
            },
        },

        methods: {
            resetValue: function(key) {
                this.locale[key] = this.currentLocale[key].message;

                if (this.showOldValueByKey === key) {
                    this.showOldValueByKey = null;
                }

                this.$forceUpdate();
            },
            getLocaleUrl: function(locale) {
                return urlPrefix + this.selectedComponentPath + '/_locales/' + locale + '/messages' + LOCALE_FILE_EXT;
            },
            async loadLocaleFromSelectedComponent() {
                this.loading = true;

                this.manifest = await load(urlPrefix + this.selectedComponentPath + '/manifest.json');
                this.defaultLocale = await load(this.getLocaleUrl(this.manifest.default_locale));

                this.$emit('locale-loaded');

                this.loading = false;
            },
            setLocale(locale) {
                this.locale = {
                    locale: locale.locale,
                    version: locale.version,
                    polyglot: locale.polyglot,
                };

                Object.keys(this.defaultLocale).forEach(function(key) {
                    if (this.notAllowedKeys.includes(key)) {
                        return;
                    }

                    if (locale[key]) {
                        this.locale[key] = locale[key].message;
                    }
                }, this);
            },
            async clickLoadLocaleFileButton() {
                let locale = await this.importFromFile();

                if (locale.component) {
                    if (this.selectedComponentName === locale.component) {
                        this.setLocale(locale);
                    } else {
                        this.$once('locale-loaded', () => this.setLocale(locale));
                        this.selectedComponentName = locale.component;
                    }
                } else {
                    this.selectedComponentName = null;
                    this.$once('locale-loaded', () => this.setLocale(locale));
                    alert('Please, select component of this file');
                }
            },
            clickSaveLocaleFileButton() {
                if (!this.locale.locale) {
                    return alert('Please, enter locale code');
                }

                let localeToSave = {
                        component: this.selectedComponentName,
                        locale: this.locale.locale,
                        version: this.manifest.version,
                        polyglot: this.locale.polyglot,
                    },
                    fileName = this.selectedComponentName + '-translation-' + this.locale.locale + LOCALE_FILE_EXT;

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
