
import Vue from '/js/vue.runtime.esm.js';

export default {
    data() {
        return {
            promptOptions: null,
            confirmOptions: null,
        };
    },
    methods: {
        prompt(title, value = '', maxlength = 256) {
            if (this.promptOptions) {
                return Promise.resolve(false);
            }

            const promptOptions = {title, value, maxlength};

            return new Promise(resolve => {
                promptOptions.resolve = ok => {
                    if (ok && promptOptions.value.length) {
                        resolve(promptOptions.value);
                    } else {
                        resolve(false);
                    }

                    this.promptOptions = null;
                };

                this.promptOptions = Vue.observable(promptOptions);
            });
        },
        confirm(title, text, lang = 'ok', classList = 'is-success') {
            if (this.confirmOptions) {
                return Promise.resolve(false);
            }

            const confirmOptions = {title, text, lang, classList};

            return new Promise(resolve => {
                confirmOptions.resolve = ok => {
                    resolve(ok);
                    this.confirmOptions = null;
                }

                this.confirmOptions = Vue.observable(confirmOptions);
            });
        },

    },
}
