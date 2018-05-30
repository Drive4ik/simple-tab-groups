const path = require('path');
const webpack = require('webpack');
const ExtractTextPlugin = require('extract-text-webpack-plugin');
const WebpackShellPlugin = require('webpack-shell-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const UglifyJsPlugin = require('uglifyjs-webpack-plugin');
const { VueLoaderPlugin } = require('vue-loader');

const setPath = function(folderName) {
    return path.join(__dirname, folderName);
};

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
    devtool: false,
    watchOptions: {
        ignored: /node_modules/,
        // poll: true,
    },
    optimization: {
        minimizer: [
            new UglifyJsPlugin({
                cache: true,
                parallel: true,
                sourceMap: false,
            })
        ],
    },
    module: {
        rules: [{
                test: /\.vue$/,
                loader: 'vue-loader',
                // options: {
                //     loaders: {
                //         scss: ExtractTextPlugin.extract({
                //             use: 'css-loader!sass-loader',
                //             fallback: 'vue-style-loader',
                //         }),
                //         sass: ExtractTextPlugin.extract({
                //             use: 'css-loader!sass-loader?indentedSyntax',
                //             fallback: 'vue-style-loader',
                //         }),
                //     }
                // },
            }, {
                test: /\.js$/,
                loader: 'babel-loader',
                // include: [path.join(__dirname, 'src')],
                exclude: file => (/node_modules/.test(file) && !/\.vue\.js/.test(file)),
            }, {
                test: /\.scss$/,
                use: [
                    'vue-style-loader',
                    'css-loader', {
                        loader: 'sass-loader',
                    },
                ],
            }, {
                test: /\.css$/,
                loader: 'vue-loader',
            }, {
                test: /\.(png|jpg|gif|svg|ico)$/,
                loader: 'file-loader',
                options: {
                    name: '[name].[ext]?emitFile=false',
                },
            },

        ],
    },
    plugins: [
        new VueLoaderPlugin(),
        // new ExtractTextPlugin({
        //     filename: '[name].css'
        // }),
        new CopyWebpackPlugin([{
            from: 'icons',
            to: 'icons',
            // ignore: ['icon.xcf'],
        }, {
            from: '_locales',
            to: '_locales',
        }, {
            from: 'css',
            to: 'css',
        }, {
            from: 'web',
            to: 'web',
        }, {
            from: 'popup/popup.html',
            to: 'popup/popup.html',
        }, {
            from: 'manage/manage.html',
            to: 'manage/manage.html',
        }, {
            from: 'options/options.html',
            to: 'options/options.html',
        }, {
            from: 'manifest.json',
            to: 'manifest.json',
        }]),
        new WebpackShellPlugin({
            onBuildEnd: ['node scripts/remove-evals.js'],
        }),
    ],
};

// if (process.env.NODE_ENV === 'production') {
//     // config.devtool = '#cheap-module-source-map';

//     config.plugins = (config.plugins || []).concat([
//         // new webpack.DefinePlugin({
//         //     'process.env': {
//         //         NODE_ENV: '"production"',
//         //     },
//         // }),
//         // new webpack.LoaderOptionsPlugin({
//         //     debug: true,
//         // }),
//         // new webpack.optimize.UglifyJsPlugin({
//         //     sourceMap: true,
//         //     compress: {
//         //         warnings: false,
//         //     },
//         // }),
//         // new webpack.LoaderOptionsPlugin({
//         //     minimize: true,
//         // }),
//     ]);
// }

// module.exports = config;
module.exports = function(env, argv) {
    // let isProduction = argv.mode === 'production';

    // config.optimization.minimize = isProduction;

    return config;
};
