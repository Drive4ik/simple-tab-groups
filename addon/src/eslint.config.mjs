
// https://eslint.org/docs/latest/use/configure/

// https://www.npmjs.com/package/globals

export default [
    {
        /* languageOptions: {
            globals: {
                self: 'readonly',
                browser: 'readonly',
                window: 'readonly',
                console: 'readonly',
                navigator: 'readonly',
                document: 'readonly',
                FileReader: 'readonly',
                Blob: 'readonly',
                URL: 'readonly',
                Image: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                localStorage: 'readonly',
                btoa: 'readonly',
                atob: 'readonly',
                process: 'readonly',
            },
        }, */
        rules: {
            "no-const-assign": "error",
            "no-unreachable": "error",
            "no-mixed-spaces-and-tabs": "error",
            "valid-typeof": "error",
            // "no-redeclare": "error",
            // "no-undef": "error",
            // "no-unused-vars": "warn",
            // "no-extra-semi": "warn",
            // "semi": "warn",
        },
    },
];
