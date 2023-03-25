const path = require('path');
const fse = require('fs-extra');
// const webpack = require('webpack');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const WebpackShellPluginNext = require('webpack-shell-plugin-next');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { VueLoaderPlugin } = require('vue-loader');

function setPath(folderName) {
    return path.join(__dirname, folderName);
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
        // 'background': './background.js',
        'popup/popup': './popup/popup.js',
        'options/options': './options/options.js',
        'manage/manage': './manage/manage.js',
        'web/hotkeys': './web/hotkeys.js',
    },
    output: {
        path: setPath('dist'),
        filename: '[name].js',
    },
    resolve: {
        extensions: ['.js', '.vue'],
    },
    node: {
        // setImmediate: false,
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
                'background.js',
                'js/logger.js',
                'js/messages.js',
                'js/constants.js',
                'js/startup.js',
                'js/utils.js',
                'js/containers.js',
                'js/storage.js',
                'js/cache.js',
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

        new WebpackShellPluginNext({
            onBuildStart:{
                // scripts: ['echo "Webpack Start"'],
                // blocking: true,
                // parallel: false,
            },
            onBuildEnd: {
                scripts: ['node scripts/remove-evals.js'],
                blocking: false,
                parallel: true,
            },
        }),
    ],
};

// module.exports = config;
module.exports = function(env, options) {
    let isProduction = options.mode === 'production';

    if (isProduction) {
        fse.removeSync(config.output.path);
    }

    // config.plugins.push(new webpack.DefinePlugin({
    //     IS_PRODUCTION: isProduction,
    // }));

    return config;
};
