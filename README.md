# Simple Tab Groups

To install Simple Tab Groups go on https://addons.mozilla.org/firefox/addon/simple-tab-groups/

## Translations

Please, help me [translate this addon](https://drive4ik.github.io/simple-tab-groups/translate/index.html) into your language!

## Usage

```bash
$ cd addon
$ npm install
$ npm run build
```

### `npm run build`

Build the extension into `addon/dist` folder for **development**.

### `npm run build:prod`

Build the extension into `addon/dist` folder for **production**.

### `npm run watch`

Watch for modifications then run `npm run build`.

### `npm run watch:prod`

Watch for modifications then run `npm run build:prod`.

### `npm run build-zip`

Build a zip file following this format `<name>-v<version>-(dev|prod).zip`, by reading `name` and `version` from `manifest.json` file.
Zip file is located in `dist-zip` folder.
