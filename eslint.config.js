
import {defineConfig} from 'eslint/config';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';

// https://eslint.org/docs/latest/use/configure/

export default defineConfig([
    ...pluginVue.configs['flat/vue2-essential'],

    {
        files: [
            'addon/**/*.js',
            'addon/**/*.vue',

            'plugins/**/*.js',
            'translate/**/*.js',
        ],
        ignores: [
            'addon/dist/',
            'addon/node_modules/',
            'addon/src/js/vue.runtime.esm.js',
        ],
        languageOptions: {
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.webextensions,
            },
        },
        rules: {
            'no-const-assign': 'error',
            'no-unreachable': 'error',
            'no-mixed-spaces-and-tabs': 'error',
            'valid-typeof': 'error',
            // 'no-redeclare': 'error',
            'no-undef': 'error',
            'no-unused-vars': 'warn',
            // 'no-extra-semi': 'warn',
            // 'semi': 'warn',
        },
    },
]);
