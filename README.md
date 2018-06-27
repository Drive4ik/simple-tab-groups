# Simple Tab Groups

To install Simple Tab Groups go on https://addons.mozilla.org/firefox/addon/simple-tab-groups/
[EXPERIMENTAL] Simple Tab Groups https://addons.mozilla.org/firefox/addon/experimental-simple-tab-groups/

## Translations

Please, help me [translate this addon](https://drive4ik.github.io/simple-tab-groups/translate/index.html) into your language!

## Usage

```bash
$ npm install
$ npm run build
```

### `npm run build`

Build the extension into `dist` folder for **production**.

### `npm run build:dev`

Build the extension into `dist` folder for **development**.

### `npm run watch`

Watch for modifications then run `npm run build`.

### `npm run watch:dev`

Watch for modifications then run `npm run build:dev`.

### `npm run build-zip`

Build a zip file following this format `<name>-v<version>.zip`, by reading `name` and `version` from `manifest.json` file.
Zip file is located in `dist-zip` folder.
