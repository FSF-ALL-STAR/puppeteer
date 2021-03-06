"use strict";
/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserFetcher = void 0;
const os = require("os");
const fs = require("fs");
const path = require("path");
const util = require("util");
const childProcess = require("child_process");
const https = require("https");
const http = require("http");
const extractZip = require("extract-zip");
const debug = require("debug");
const removeRecursive = require("rimraf");
const URL = require("url");
const ProxyAgent = require("https-proxy-agent");
const proxy_from_env_1 = require("proxy-from-env");
const helper_1 = require("./helper");
const debugFetcher = debug(`puppeteer:fetcher`);
const downloadURLs = {
    chrome: {
        linux: '%s/chromium-browser-snapshots/Linux_x64/%d/%s.zip',
        mac: '%s/chromium-browser-snapshots/Mac/%d/%s.zip',
        win32: '%s/chromium-browser-snapshots/Win/%d/%s.zip',
        win64: '%s/chromium-browser-snapshots/Win_x64/%d/%s.zip',
    },
    firefox: {
        linux: '%s/firefox-%s.en-US.%s-x86_64.tar.bz2',
        mac: '%s/firefox-%s.en-US.%s.dmg',
        win32: '%s/firefox-%s.en-US.%s.zip',
        win64: '%s/firefox-%s.en-US.%s.zip',
    },
};
const browserConfig = {
    chrome: {
        host: 'https://storage.googleapis.com',
        destination: '.local-chromium',
    },
    firefox: {
        host: 'https://archive.mozilla.org/pub/firefox/nightly/latest-mozilla-central',
        destination: '.local-firefox',
    },
};
function archiveName(product, platform, revision) {
    if (product === 'chrome') {
        if (platform === 'linux')
            return 'chrome-linux';
        if (platform === 'mac')
            return 'chrome-mac';
        if (platform === 'win32' || platform === 'win64') {
            // Windows archive name changed at r591479.
            return parseInt(revision, 10) > 591479 ? 'chrome-win' : 'chrome-win32';
        }
    }
    else if (product === 'firefox') {
        return platform;
    }
}
/**
 * @param {string} product
 * @param {string} platform
 * @param {string} host
 * @param {string} revision
 * @return {string}
 */
function downloadURL(product, platform, host, revision) {
    const url = util.format(downloadURLs[product][platform], host, revision, archiveName(product, platform, revision));
    return url;
}
const readdirAsync = helper_1.helper.promisify(fs.readdir.bind(fs));
const mkdirAsync = helper_1.helper.promisify(fs.mkdir.bind(fs));
const unlinkAsync = helper_1.helper.promisify(fs.unlink.bind(fs));
const chmodAsync = helper_1.helper.promisify(fs.chmod.bind(fs));
function existsAsync(filePath) {
    return new Promise((resolve) => {
        fs.access(filePath, (err) => resolve(!err));
    });
}
/**
 */
class BrowserFetcher {
    constructor(projectRoot, options = {}) {
        this._product = (options.product || 'chrome').toLowerCase();
        helper_1.assert(this._product === 'chrome' || this._product === 'firefox', `Unknown product: "${options.product}"`);
        this._downloadsFolder =
            options.path ||
                path.join(projectRoot, browserConfig[this._product].destination);
        this._downloadHost = options.host || browserConfig[this._product].host;
        this.setPlatform(options.platform);
        helper_1.assert(downloadURLs[this._product][this._platform], 'Unsupported platform: ' + this._platform);
    }
    setPlatform(platformFromOptions) {
        if (platformFromOptions) {
            this._platform = platformFromOptions;
            return;
        }
        const platform = os.platform();
        if (platform === 'darwin')
            this._platform = 'mac';
        else if (platform === 'linux')
            this._platform = 'linux';
        else if (platform === 'win32')
            this._platform = os.arch() === 'x64' ? 'win64' : 'win32';
        else
            helper_1.assert(this._platform, 'Unsupported platform: ' + os.platform());
    }
    platform() {
        return this._platform;
    }
    product() {
        return this._product;
    }
    host() {
        return this._downloadHost;
    }
    canDownload(revision) {
        const url = downloadURL(this._product, this._platform, this._downloadHost, revision);
        return new Promise((resolve) => {
            const request = httpRequest(url, 'HEAD', (response) => {
                resolve(response.statusCode === 200);
            });
            request.on('error', (error) => {
                console.error(error);
                resolve(false);
            });
        });
    }
    /**
     * @param {string} revision
     * @param {?function(number, number):void} progressCallback
     * @return {!Promise<!BrowserFetcher.RevisionInfo>}
     */
    async download(revision, progressCallback) {
        const url = downloadURL(this._product, this._platform, this._downloadHost, revision);
        const fileName = url.split('/').pop();
        const archivePath = path.join(this._downloadsFolder, fileName);
        const outputPath = this._getFolderPath(revision);
        if (await existsAsync(outputPath))
            return this.revisionInfo(revision);
        if (!(await existsAsync(this._downloadsFolder)))
            await mkdirAsync(this._downloadsFolder);
        try {
            await downloadFile(url, archivePath, progressCallback);
            await install(archivePath, outputPath);
        }
        finally {
            if (await existsAsync(archivePath))
                await unlinkAsync(archivePath);
        }
        const revisionInfo = this.revisionInfo(revision);
        if (revisionInfo)
            await chmodAsync(revisionInfo.executablePath, 0o755);
        return revisionInfo;
    }
    async localRevisions() {
        if (!(await existsAsync(this._downloadsFolder)))
            return [];
        const fileNames = await readdirAsync(this._downloadsFolder);
        return fileNames
            .map((fileName) => parseFolderPath(this._product, fileName))
            .filter((entry) => entry && entry.platform === this._platform)
            .map((entry) => entry.revision);
    }
    async remove(revision) {
        const folderPath = this._getFolderPath(revision);
        helper_1.assert(await existsAsync(folderPath), `Failed to remove: revision ${revision} is not downloaded`);
        await new Promise((fulfill) => removeRecursive(folderPath, fulfill));
    }
    revisionInfo(revision) {
        const folderPath = this._getFolderPath(revision);
        let executablePath = '';
        if (this._product === 'chrome') {
            if (this._platform === 'mac')
                executablePath = path.join(folderPath, archiveName(this._product, this._platform, revision), 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
            else if (this._platform === 'linux')
                executablePath = path.join(folderPath, archiveName(this._product, this._platform, revision), 'chrome');
            else if (this._platform === 'win32' || this._platform === 'win64')
                executablePath = path.join(folderPath, archiveName(this._product, this._platform, revision), 'chrome.exe');
            else
                throw new Error('Unsupported platform: ' + this._platform);
        }
        else if (this._product === 'firefox') {
            if (this._platform === 'mac')
                executablePath = path.join(folderPath, 'Firefox Nightly.app', 'Contents', 'MacOS', 'firefox');
            else if (this._platform === 'linux')
                executablePath = path.join(folderPath, 'firefox', 'firefox');
            else if (this._platform === 'win32' || this._platform === 'win64')
                executablePath = path.join(folderPath, 'firefox', 'firefox.exe');
            else
                throw new Error('Unsupported platform: ' + this._platform);
        }
        else {
            throw new Error('Unsupported product: ' + this._product);
        }
        const url = downloadURL(this._product, this._platform, this._downloadHost, revision);
        const local = fs.existsSync(folderPath);
        debugFetcher({
            revision,
            executablePath,
            folderPath,
            local,
            url,
            product: this._product,
        });
        return {
            revision,
            executablePath,
            folderPath,
            local,
            url,
            product: this._product,
        };
    }
    /**
     * @param {string} revision
     * @return {string}
     */
    _getFolderPath(revision) {
        return path.join(this._downloadsFolder, this._platform + '-' + revision);
    }
}
exports.BrowserFetcher = BrowserFetcher;
function parseFolderPath(product, folderPath) {
    const name = path.basename(folderPath);
    const splits = name.split('-');
    if (splits.length !== 2)
        return null;
    const [platform, revision] = splits;
    if (!downloadURLs[product][platform])
        return null;
    return { product, platform, revision };
}
/**
 * @param {string} url
 * @param {string} destinationPath
 * @param {?function(number, number):void} progressCallback
 * @return {!Promise}
 */
function downloadFile(url, destinationPath, progressCallback) {
    debugFetcher(`Downloading binary from ${url}`);
    let fulfill, reject;
    let downloadedBytes = 0;
    let totalBytes = 0;
    const promise = new Promise((x, y) => {
        fulfill = x;
        reject = y;
    });
    const request = httpRequest(url, 'GET', (response) => {
        if (response.statusCode !== 200) {
            const error = new Error(`Download failed: server returned code ${response.statusCode}. URL: ${url}`);
            // consume response data to free up memory
            response.resume();
            reject(error);
            return;
        }
        const file = fs.createWriteStream(destinationPath);
        file.on('finish', () => fulfill());
        file.on('error', (error) => reject(error));
        response.pipe(file);
        totalBytes = parseInt(
        /** @type {string} */ response.headers['content-length'], 10);
        if (progressCallback)
            response.on('data', onData);
    });
    request.on('error', (error) => reject(error));
    return promise;
    function onData(chunk) {
        downloadedBytes += chunk.length;
        progressCallback(downloadedBytes, totalBytes);
    }
}
function install(archivePath, folderPath) {
    debugFetcher(`Installing ${archivePath} to ${folderPath}`);
    if (archivePath.endsWith('.zip'))
        return extractZip(archivePath, { dir: folderPath });
    else if (archivePath.endsWith('.tar.bz2'))
        return extractTar(archivePath, folderPath);
    else if (archivePath.endsWith('.dmg'))
        return mkdirAsync(folderPath).then(() => installDMG(archivePath, folderPath));
    else
        throw new Error(`Unsupported archive format: ${archivePath}`);
}
/**
 * @param {string} tarPath
 * @param {string} folderPath
 * @return {!Promise<?Error>}
 */
function extractTar(tarPath, folderPath) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const tar = require('tar-fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bzip = require('unbzip2-stream');
    return new Promise((fulfill, reject) => {
        const tarStream = tar.extract(folderPath);
        tarStream.on('error', reject);
        tarStream.on('finish', fulfill);
        const readStream = fs.createReadStream(tarPath);
        readStream.on('data', () => {
            process.stdout.write('\rExtracting...');
        });
        readStream.pipe(bzip()).pipe(tarStream);
    });
}
/**
 * Install *.app directory from dmg file
 *
 * @param {string} dmgPath
 * @param {string} folderPath
 * @return {!Promise<?Error>}
 */
function installDMG(dmgPath, folderPath) {
    let mountPath;
    function mountAndCopy(fulfill, reject) {
        const mountCommand = `hdiutil attach -nobrowse -noautoopen "${dmgPath}"`;
        childProcess.exec(mountCommand, (err, stdout) => {
            if (err)
                return reject(err);
            const volumes = stdout.match(/\/Volumes\/(.*)/m);
            if (!volumes)
                return reject(new Error(`Could not find volume path in ${stdout}`));
            mountPath = volumes[0];
            readdirAsync(mountPath)
                .then((fileNames) => {
                const appName = fileNames.filter((item) => typeof item === 'string' && item.endsWith('.app'))[0];
                if (!appName)
                    return reject(new Error(`Cannot find app in ${mountPath}`));
                const copyPath = path.join(mountPath, appName);
                debugFetcher(`Copying ${copyPath} to ${folderPath}`);
                childProcess.exec(`cp -R "${copyPath}" "${folderPath}"`, (err) => {
                    if (err)
                        reject(err);
                    else
                        fulfill();
                });
            })
                .catch(reject);
        });
    }
    function unmount() {
        if (!mountPath)
            return;
        const unmountCommand = `hdiutil detach "${mountPath}" -quiet`;
        debugFetcher(`Unmounting ${mountPath}`);
        childProcess.exec(unmountCommand, (err) => {
            if (err)
                console.error(`Error unmounting dmg: ${err}`);
        });
    }
    return new Promise(mountAndCopy)
        .catch((error) => {
        console.error(error);
    })
        .finally(unmount);
}
function httpRequest(url, method, response) {
    const urlParsed = URL.parse(url);
    let options = {
        ...urlParsed,
        method,
    };
    const proxyURL = proxy_from_env_1.getProxyForUrl(url);
    if (proxyURL) {
        if (url.startsWith('http:')) {
            const proxy = URL.parse(proxyURL);
            options = {
                path: options.href,
                host: proxy.hostname,
                port: proxy.port,
            };
        }
        else {
            const parsedProxyURL = URL.parse(proxyURL);
            const proxyOptions = {
                ...parsedProxyURL,
                secureProxy: parsedProxyURL.protocol === 'https:',
            };
            options.agent = new ProxyAgent(proxyOptions);
            options.rejectUnauthorized = false;
        }
    }
    const requestCallback = (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
            httpRequest(res.headers.location, method, response);
        else
            response(res);
    };
    const request = options.protocol === 'https:'
        ? https.request(options, requestCallback)
        : http.request(options, requestCallback);
    request.end();
    return request;
}
