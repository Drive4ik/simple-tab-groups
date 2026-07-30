#!/usr/bin/env node

import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const addonDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testSearchDir = path.join(addonDir, 'src', 'js');

function isTestFileName(fileName) {
    return fileName.endsWith('.test.mjs') && !fileName.endsWith('.test.loader.mjs');
}

async function findTestFiles(dir) {
    const entries = await readdir(dir, {withFileTypes: true});
    const testFiles = [];

    for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            testFiles.push(...await findTestFiles(entryPath));
        } else if (entry.isFile() && isTestFileName(entry.name)) {
            testFiles.push(entryPath);
        }
    }

    return testFiles;
}

function runTestFile(testFile) {
    const {status} = spawnSync(process.execPath, [testFile], {
        stdio: 'inherit',
        cwd: path.dirname(testFile),
    });

    return status === 0;
}

const testFiles = (await findTestFiles(testSearchDir)).sort();
const failedTestFiles = [];

for (const testFile of testFiles) {
    const testName = path.relative(addonDir, testFile);

    console.log(`\n===== ${testName} =====`);

    if (!runTestFile(testFile)) {
        failedTestFiles.push(testName);
    }
}

const passedCount = testFiles.length - failedTestFiles.length;

console.log(`\ntest files: ${testFiles.length}, passed: ${passedCount}, failed: ${failedTestFiles.length}`);

for (const testName of failedTestFiles) {
    console.log(`FAILED: ${testName}`);
}

process.exit(failedTestFiles.length ? 1 : 0);
