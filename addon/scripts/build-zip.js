#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zipFolder = require('zip-folder');

const DEST_DIR = path.join(__dirname, '../dist');
const DEST_ZIP_DIR = path.join(__dirname, '../dist-zip');

const extractExtensionData = () => {
    const manifest = require('../src/manifest.json');

    return {
        name: manifest.applications.gecko.id,
        version: manifest.version,
    }
}

const makeDestZipDirIfNotExists = () => {
    if (!fs.existsSync(DEST_ZIP_DIR)) {
        fs.mkdirSync(DEST_ZIP_DIR);
    }
}

const buildZip = (src, dist, zipFilename) => {
    console.info(`Building ${zipFilename}...`);

    return new Promise((resolve, reject) => {
        zipFolder(src, path.join(dist, zipFilename), (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
};

const main = () => {
    const { name, version } = extractExtensionData();
    const prod = process.env.IS_PRODUCTION ? 'prod' : 'dev';
    const zipFilename = `${name}-v${version}-${prod}.zip`;

    makeDestZipDirIfNotExists();

    buildZip(DEST_DIR, DEST_ZIP_DIR, zipFilename)
        .then(() => console.info('OK'))
        .catch(console.err);
};

main();
