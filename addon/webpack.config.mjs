import path from 'path';
import fse from 'fs-extra';
// import webpack from 'webpack';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import { VueLoaderPlugin } from 'vue-loader';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function setPath(folderName) {
    return path.resolve(__dirname, folderName);
}

function copy(path) {
    return {
        from: path,
        to: path,
    };
}

function multipleCopy(paths) {
    return paths.map(copy);
}

const config = {
    context: setPath('src'),
    entry: {
        'popup/popup': './popup/popup.js',
        'options/options': './options/options.js',
        'manage/manage': './manage/manage.js',
        'web/hotkeys': './web/hotkeys.js',
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
    externals: {
        vue: '/js/vue.runtime.esm.min.js',
        background: '/js/background.js',
        'wait-background': '/js/wait-background.js',
        constants: '/js/constants.js',
        messages: '/js/messages.js',
        logger: '/js/logger.js',
        containers: '/js/containers.js',
        file: '/js/file.js',
        urls: '/js/urls.js',
        cache: '/js/cache.js',
        groups: '/js/groups.js',
        windows: '/js/windows.js',
        management: '/js/management.js',
        tabs: '/js/tabs.js',
        utils: '/js/utils.js',
        json: '/js/json.js',
        storage: '/js/storage.js',
    },
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
        minimize: false,
    },
    module: {
        rules: [
            {
                test: /\.vue$/,
                loader: 'vue-loader',
            },
            {
                test: /\.(scss|css)$/,
                use: [
                    MiniCssExtractPlugin.loader,
                    'css-loader',
                    'sass-loader',
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
            patterns: multipleCopy([
                // folders
                'icons',
                'help',
                '_locales',
                'css',

                // js
                'stg-background.js',
                'stg-background.html',

                'js/vue.runtime.esm.min.js',
                'js/background.js',
                'js/wait-background.js',
                'js/logger.js',
                'js/messages.js',
                'js/constants.js',
                'js/browser-constants.js',
                'js/utils.js',
                'js/json.js',
                'js/menus.js',
                'js/urls.js',
                'js/containers.js',
                'js/storage.js',
                'js/cache.js',
                'js/cache-storage.js',
                'js/file.js',
                'js/groups.js',
                'js/tabs.js',
                'js/windows.js',
                'js/management.js',

                // pages
                'popup/popup.html',
                'manage/manage.html',
                'options/options.html',

                // manifest
                'manifest.json',
            ]),
        }),
    ],
};

export default function(env, options) {
    let isProduction = options.mode === 'production';

    if (isProduction) {
        fse.removeSync(config.output.path);
    }

    // config.plugins.push(new webpack.DefinePlugin({
    //     IS_PRODUCTION: isProduction,
    // }));

    return config;
};
