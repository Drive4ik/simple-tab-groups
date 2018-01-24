(async function() {
    'use strict';

    const LOCALE_FILE_EXT = '.json',
        urlPrefix = 'https://raw.githubusercontent.com/Drive4ik/simple-tab-groups/master/addon/';

    let notAllowedKeys = ['locale', 'version', 'polyglot'],
        manifestBlob = await fetch(urlPrefix + 'manifest.json'),
        manifest = await manifestBlob.json();

    let tr = new Vue({
        el: '#content',
        data: {
            manifest: manifest,

            defaultLocale: {},

            locale: {},
        },

        async mounted() {
            let defaultLocaleBlob = await fetch(urlPrefix + '_locales/${manifest.default_locale}/messages.json');

            this.defaultLocale = await defaultLocaleBlob.json();
        },

        methods: {
            loadLocaleFile(locale) {
                this.locale = {
                    locale: locale.locale,
                    version: locale.version,
                    polyglot: locale.polyglot,
                };

                Object.keys(locale).forEach(function(key) {
                    if (notAllowedKeys.includes(key)) {
                        return;
                    }

                    if (!this.defaultLocale[key]) {
                        return;
                    }

                    this.locale[key] = locale[key].message;
                }, this);
            },
            async clickLoadLocaleFileButton() {
                let locale = await this.importFromFile();
                this.loadLocaleFile(locale);
            },
            clickSaveLocaleFileButton() {
                if (!this.locale.locale) {
                    return alert('No locale selected');
                }

                let localeToSave = {
                        locale: this.locale.locale,
                        version: this.manifest.version,
                        polyglot: this.locale.polyglot,
                    },
                    fileName = 'simple-tab-groups-translation-' + this.locale.locale + LOCALE_FILE_EXT;

                Object.keys(this.locale).forEach(function(key) {
                    if (notAllowedKeys.includes(key)) {
                        return;
                    }

                    if (!this.locale[key]) {
                        return;
                    }

                    localeToSave[key] = {
                        message: this.locale[key],
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
