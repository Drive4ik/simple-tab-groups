import path from 'path';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import TerserPlugin from 'minimizer-webpack-plugin';
import { VueLoaderPlugin } from 'vue-loader';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TERSER_OPTIONS = {
    module: true,
    keep_fnames: true,
    keep_classnames: true,
};

function setPath(folderName) {
    return path.resolve(__dirname, folderName);
}

function copyPathObj(path) {
    if (typeof path === 'string') {
        return {
            from: path,
            to: path,
            // never ship dev-only test files (e.g. js/sync/delta/*.test.mjs) into the addon
            globOptions: {
                ignore: ['**/*.test.*'],
            },
        };
    }

    return path;
}

const THIRD_PARTY_LIBRARIES = new Map([
    ['vue', '/js/vue.runtime.esm.js'],
]);

export default {
    context: setPath('src'),
    entry: {
        'popup/popup': './popup/popup.js',
        'options/options': './options/options.js',
        'manage/manage': './manage/manage.js',
        'web/content-script': './web/content-script.js',
    },
    experiments: {
        outputModule: true,
        // topLevelAwait: true,
    },
    output: {
        path: setPath('dist'),
        filename: '[name].js',
        module: true,
        chunkFormat: 'module',
    },
    externals: [
        function ({request}, callback) {
            if (request.startsWith('/js/')) {
                callback(null, request);
            } else if (THIRD_PARTY_LIBRARIES.has(request)) {
                callback(null, THIRD_PARTY_LIBRARIES.get(request));
            } else {
                callback();
            }
        },
    ],
    externalsType: 'module',
    resolve: {
        extensions: ['.js', '.vue'],
    },
    watchOptions: {
        ignored: /node_modules/,
        poll: true,
    },
    stats: {
        // entrypoints: false,
        children: false,
    },
    devtool: false,
    optimization: {
        minimize: true,
        minimizer: [
            new TerserPlugin({
                terserOptions: TERSER_OPTIONS,
            }),
        ],
    },
    performance: {
        maxEntrypointSize: 1024000,
        maxAssetSize: 1024000,
    },
    module: {
        rules: [
            {
                test: /\.vue$/,
                loader: 'vue-loader',
            },
            {
                test: /\.css$/,
                use: [
                    MiniCssExtractPlugin.loader,
                    'css-loader',
                ]
            },
        ],
    },
    plugins: [
        new VueLoaderPlugin(),

        new MiniCssExtractPlugin({
            // Options similar to the same options in webpackOptions.output
            // both options are optional
            filename: '[name].css',
            // chunkFilename: '[id].css',
        }),

        new CopyWebpackPlugin({
            patterns: [
                // folders
                'icons',
                'help',
                '_locales',
                'css',

                // js
                'js',
                'background.js',

                // css
                'web/content-script.css',

                // pages
                'popup/popup.html',
                'manage/manage.html',
                'options/options.html',

                // manifest
                'manifest.json',
            ].map(copyPathObj),
        }),
    ],
}
