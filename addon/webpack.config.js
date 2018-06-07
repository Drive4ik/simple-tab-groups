const path = require('path');
const webpack = require('webpack');
const ExtractTextPlugin = require('extract-text-webpack-plugin');
const WebpackShellPlugin = require('webpack-shell-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const UglifyJsPlugin = require('uglifyjs-webpack-plugin');
const DelWebpackPlugin = require('del-webpack-plugin');
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
    optimization: {
        minimizer: [
            new UglifyJsPlugin({
                cache: true,
                parallel: true,
                sourceMap: false,
                uglifyOptions: {
                    ecma: 6,
                    compress: {
                        drop_console: true,
                    },
                },
            })
        ],
    },
    module: {
        rules: [
            {
                test: /\.vue$/,
                loader: 'vue-loader',
            },
            {
                test: /\.scss$/,
                use: ['vue-style-loader', 'css-loader', 'sass-loader'],
            },
            {
                test: /\.css$/,
                use: ExtractTextPlugin.extract(['css-loader']),
                // use: ['style-loader', 'css-loader'],
            }
        ],
    },
    plugins: [
        new VueLoaderPlugin(),

        new ExtractTextPlugin({
            filename: '[name].css'
        }),

        new CopyWebpackPlugin(multipleCopy('icons', '_locales', 'css', 'web', 'popup/popup.html', 'manage/manage.html', 'options/options.html', 'manifest.json')),

        new WebpackShellPlugin({
            onBuildEnd: ['node scripts/remove-evals.js'],
        }),
    ],
};

// module.exports = config;
module.exports = function(env, options) {
    let isProduction = options.mode === 'production';

    config.devtool = isProduction ? false : 'source-map';

    if (isProduction) {
        config.plugins.push(new DelWebpackPlugin({
            include: ['*.map', '**/*.map'],
        }));
    }

    config.plugins.push(new webpack.DefinePlugin({
        IS_PRODUCTION: isProduction,
    }));

    return config;
};
