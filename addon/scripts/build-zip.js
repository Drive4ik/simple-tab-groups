#!/usr/bin/env node

import fse from 'fs-extra';
import path from 'path';
import ZipAFolder from 'zip-a-folder';
import { fileURLToPath } from 'url';
import manifest from '../src/manifest.json' assert { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function setPath(folderName) {
    return path.resolve(__dirname, '../' + folderName);
}

function extractExtensionData() {
    return {
        name: manifest.browser_specific_settings.gecko.id,
        version: manifest.version,
    };
}

function buildZip(src, dist, zipFilename) {
    console.info(`\n------------------\nBuilding ${zipFilename}...`);

    fse.ensureDirSync(dist);

    return ZipAFolder.zip(src, path.resolve(dist, zipFilename));
};

function init() {
    let { name, version } = extractExtensionData(),
        prod = process.env.IS_PRODUCTION ? 'prod' : 'dev',
        zipFilename = `${name}-v${version}-${prod}.zip`,
        distZipPath = setPath('dist-zip');

    if (process.env.IS_PRODUCTION) {
        buildZip(setPath('dist'), distZipPath, zipFilename)
            .then(() => console.info('\nBuild ZIP OK'))
            .catch(console.error.bind(console, 'can\'t buildZip PROD'));
    } else {
        let devPath = setPath('dev'),
            setDevPath = path.resolve.bind(path, devPath);

        fse.copySync(setPath('src'), setDevPath('src'));
        fse.copySync(setPath('scripts'), setDevPath('scripts'));
        fse.copySync(setPath('README.md'), setDevPath('README.md'));
        fse.copySync(setPath('package.json'), setDevPath('package.json'));
        fse.copySync(setPath('package-lock.json'), setDevPath('package-lock.json'));
        fse.copySync(setPath('webpack.config.mjs'), setDevPath('webpack.config.mjs'));

        buildZip(devPath, distZipPath, zipFilename)
            .then(function() {
                fse.removeSync(devPath);

                console.info('\nBuild ZIP OK');
            })
            .catch(console.error.bind(console, 'can\'t buildZip DEV'));
    }

};

init();
