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

const replaceEvalRegexp = {
    dev: [{
        fr: /;\s*\/\/ This works in non-strict mode\s*([a-z])\s*=\s*\(\s*function\(\)\s*\{\s*return this;\s*}\)\(\);\s*try\s*{\s*\/\/\s*This works if eval is allowed(?:\s*|.+){1,14}/g,
        to: '=window;',
    }, {
        fr: 'self.Math==Math?self:Function("return this")();',
        to: 'self.Math==Math?self:window;',
    }, {
        fr: 'svgContainer.innerHTML = "<svg>"',
        to: 'svgContainer.innerText = "<svg>"',
    }],
    prod: [{
        fr: /;([a-z])=function\(\){return this}\(\);try{\1=\1\|\|new Function\("return this"\)\(\)}catch\([a-z]\){"object"==typeof window&&\(\1=window\)}/g,
        to: '=window;',
    }, {
        fr: 'self.Math==Math?self:Function("return this")();',
        to: 'self.Math==Math?self:window;',
    }, {
        fr: 'document.createElement("div")).innerHTML="<svg>"',
        to: 'document.createElement("div")).innerText="<svg>"',
    }],
};

function removeEvals(file) {
    return new Promise((resolve, reject) => {
        fs.readFile(file, 'utf8', function(err, data) {
            if (err) {
                reject(err);
                return;
            }

            let regexArray = process.env.IS_PRODUCTION ? replaceEvalRegexp.prod : replaceEvalRegexp.dev;

            console.info('File: ' + file);

            let notFound = regexArray.some(function({fr, to}) {
                if ('string' === typeof fr) {
                    if (!data.includes(fr)) {
                        reject(`===> Error: no string '${fr}' found in ${file}.`);
                        return true;
                    }

                    console.info('Replace string OK');
                } else { // regexp
                    if (!fr.test(data)) {
                        reject(`===> Error: no eval CSP specific code found in ${file}.`);
                        return true;
                    }

                    console.info('Removing eval() OK');
                }

                data = data.replace(fr, to);
            });

            if (notFound) {
                return;
            }

            fs.writeFile(file, data, err => err ? reject(err) : resolve());
        });
    });
}

function main() {
    console.info('============= remove evals =============');

    bundles.forEach(async function(bundle) {
        try {
            await removeEvals(path.join(BUNDLE_DIR, bundle))
            console.info(`Bundle ${bundle}: OK`);
        } catch (e) {
            console.error(`\n${e}\n`);
        }
    });
}

main();
