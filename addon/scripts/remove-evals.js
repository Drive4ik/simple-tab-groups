#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

const BUNDLE_DIR = path.join(__dirname, '../dist');
const bundles = [
    // 'background.js',
    'popup/popup.js',
    'manage/manage.js',
    'options/options.js',
];

const evalRegexForProduction = /;([a-z])=function\(\){return this}\(\);try{\1=\1\|\|Function\("return this"\)\(\)\|\|\(0,eval\)\("this"\)}catch\(t\){"object"==typeof window&&\(\1=window\)}/g;
const evalRegexForDevelopment = /;\s*\/\/ This works in non-strict mode\s*([a-z])\s*=\s*\(\s*function\(\)\s*\{\s*return this;\s*}\)\(\);\s*try\s*{\s*\/\/\s*This works if eval is allowed(?:\s*|.+){1,14}/g;

const removeEvals = (file) => {
    console.info(`Removing eval() from ${file}`);

    return new Promise((resolve, reject) => {
        fs.readFile(file, 'utf8', (err, data) => {
            if (err) {
                reject(err);
                return;
            }

            data = data.replace('self.Math==Math?self:Function("return this")();', 'self.Math==Math?self:window;'); // vue-swatches plugin

            const regex = process.env.IS_PRODUCTION ? evalRegexForProduction : evalRegexForDevelopment;

            if (!regex.test(data)) {
                reject(`No CSP specific code found in ${file}.`);
                return;
            }

            data = data.replace(regex, '=window;');

            fs.writeFile(file, data, err => err ? reject(err) : resolve());
        });
    });
};

const main = () => {
    bundles.forEach(bundle => {
        removeEvals(path.join(BUNDLE_DIR, bundle))
            .then(() => console.info(`Bundle ${bundle}: OK`))
            .catch(console.error);
    });
};

main();
