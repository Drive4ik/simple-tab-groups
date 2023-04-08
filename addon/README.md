### Instructions for Mozilla reviewers

I have the source code in the vue and js files. With the command `npm run build` you create a build on pure js which is located in the dist folder.
The `npm run build-zip` command will create 2 zip archives in the `dist-zip` folder.
The file `simple-tab-groups@drive4ik-v5.0-dev.zip` has the source code - I upload it with each release.
The file `simple-tab-groups@drive4ik-v5.0-prod.zip` has compiled code from the command `npm run build`, which actually gets into the resulting XPI file.
All these commands and their execution are described in the `package.json` file.
How the build is going and with what settings you can also see in the file `webpack.config.mjs`

I use Windows 10 x64

```
$ node -v
v18.15.0

$ npm -v
9.5.0
```

Build code:

```bash
$ npm install
$ npm run build
```

This code will be located in the `dist` folder.

Create ZIP archives:

```bash
$ npm install
$ npm run build-zip
```

### Third-party libraries

This addon uses the third-party javascript library - Vue.
The Vue framework does not have an official CDN. So I took the file "vue.runtime.esm.js" from the CDN which is listed on their official website:
https://v2.vuejs.org/v2/guide/installation.html#CDN

The file `src/js/vue.runtime.esm.js` has version `2.7.14`, and downloaded from:
https://cdn.jsdelivr.net/npm/vue@2.7.14/dist/vue.runtime.esm.js

This is the stable production version.

Best regards.
