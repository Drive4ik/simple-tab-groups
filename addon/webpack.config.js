const path = require('path');
const webpack = require('webpack');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const WebpackShellPlugin = require('webpack-shell-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');
const OptimizeCSSAssetsPlugin = require('optimize-css-assets-webpack-plugin');
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

function multipleCopy(...paths) {
    return paths.map(copy);
}

const config = {
    context: setPath('src'),
    entry: {
        'background': './background.js',
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
        setImmediate: false,
    },
    watchOptions: {
        ignored: /node_modules/,
    },
    stats: {
        // entrypoints: false,
        children: false,
    },
    devtool: false,
    optimization: {
        minimizer: [
            new TerserPlugin({
                parallel: true,
                terserOptions: {
                    ecma: 8,
                    compress: {
                        drop_console: true,
                    },
                },
            }),
            new OptimizeCSSAssetsPlugin({}),
        ],
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
                    {
                        loader: 'css-loader',
                        // options: {
                        //     minimize: {
                        //         safe: true,
                        //     },
                        // },
                    },
                    {
                        loader: 'sass-loader',
                        // options: {},
                    },
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
            // chunkFilename: "[id].css"
        }),

        new CopyWebpackPlugin(multipleCopy('icons', '_locales', 'css', 'popup/popup.html', 'manage/manage.html', 'options/options.html', 'manifest.json')),

        new WebpackShellPlugin({
            onBuildEnd: ['node scripts/remove-evals.js'],
        }),
    ],
};

// module.exports = config;
module.exports = function(env, options) {
    let isProduction = options.mode === 'production';

    config.plugins.push(new webpack.DefinePlugin({
        IS_PRODUCTION: isProduction,
    }));

    return config;
};
