#!/usr/bin/env node

const fse = require('fs-extra');
const path = require('path');
const ZipAFolder = require('zip-a-folder');

function setPath(folderName) {
    return path.join(__dirname, '../' + folderName);
}

function extractExtensionData() {
    let manifest = require('../src/manifest.json');

    return {
        name: manifest.browser_specific_settings.gecko.id,
        version: manifest.version,
    };
}

function buildZip(src, dist, zipFilename) {
    console.info(`\n------------------\nBuilding ${zipFilename}...`);

    fse.ensureDirSync(dist);

    return ZipAFolder.zip(src, path.join(dist, zipFilename));
};

function init() {
    let { name, version } = extractExtensionData(),
        prod = process.env.IS_PRODUCTION ? 'prod' : 'dev',
        zipFilename = `${name}-v${version}-${prod}.zip`,
        distZipPath = setPath('dist-zip');

    if (process.env.IS_PRODUCTION) {
        buildZip(setPath('dist'), distZipPath, zipFilename)
            .then(() => console.info('\nBuild ZIP OK'))
            .catch(console.err);
    } else {
        let devPath = setPath('dev'),
            setDevPath = path.join.bind(path, devPath);

        fse.copySync(setPath('src'), setDevPath('src'));
        fse.copySync(setPath('scripts'), setDevPath('scripts'));
        fse.copySync(setPath('README.md'), setDevPath('README.md'));
        fse.copySync(setPath('package.json'), setDevPath('package.json'));
        fse.copySync(setPath('package-lock.json'), setDevPath('package-lock.json'));
        fse.copySync(setPath('webpack.config.js'), setDevPath('webpack.config.js'));

        buildZip(devPath, distZipPath, zipFilename)
            .then(function() {
                fse.removeSync(devPath);

                console.info('\nBuild ZIP OK');
            })
            .catch(console.err);
    }

};

init();
