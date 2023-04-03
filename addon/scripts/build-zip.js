#!/usr/bin/env node

import fse from 'fs-extra';
import path from 'path';
import {zip, COMPRESSION_LEVEL} from 'zip-a-folder';
import { fileURLToPath } from 'url';
import webpack from 'webpack';
import config from '../webpack.config.mjs';
import manifest from '../src/manifest.json' assert { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function setPath(folderName) {
    return path.resolve(__dirname, '../' + folderName);
}

async function compressToZip(src, dist, zipFilename) {
    console.log(`Compressing ${zipFilename}...`);

    await fse.ensureDir(dist);

    const distZipFullPath = path.resolve(dist, zipFilename);

    await fse.remove(distZipFullPath);

    await zip(src, distZipFullPath, {
        compression: COMPRESSION_LEVEL.high,
    });

    console.log(`Compress ${zipFilename} Success!`);
}

async function webpackBuild() {
    config.mode = 'production';

    const compiler = webpack(config);

    console.log('Building the addon with webpack...');

    return await new Promise((resolve, reject) => {
        compiler.run((err, res) => {
            if (err) {
                reject(err);
            } else {
                resolve(res);
            }
        });
    });
}

function getZipFileName(env) {
    const addonId = manifest.browser_specific_settings.gecko.id;
    const version = manifest.version;

    return `${addonId}-v${version}-${env}.zip`;
}

async function init() {
    console.info(`\nStarting create zip's\n`);

    const distZipPath = setPath('dist-zip');

    // build PROD zip
    const prodPath = config.output.path;
    const prodFileName = getZipFileName('prod');

    await fse.remove(prodPath); // clear

    await webpackBuild();

    await compressToZip(prodPath, distZipPath, prodFileName);

    console.log(`\n---\n`);

    // build DEV source code zip
    const devPath = setPath('dev');
    const devFileName = getZipFileName('dev');
    const setDevPath = path.resolve.bind(path, devPath);

    console.log('Creating source zip...');

    await fse.remove(devPath); // clear before

    await fse.copy(setPath('src'), setDevPath('src'));
    await fse.copy(setPath('scripts'), setDevPath('scripts'));
    await fse.copy(setPath('README.md'), setDevPath('README.md'));
    await fse.copy(setPath('package.json'), setDevPath('package.json'));
    await fse.copy(setPath('package-lock.json'), setDevPath('package-lock.json'));
    await fse.copy(setPath('webpack.config.mjs'), setDevPath('webpack.config.mjs'));

    await compressToZip(devPath, distZipPath, devFileName);

    await fse.remove(devPath); // clear after

    console.info('\nAll finished!');
};

await init();
