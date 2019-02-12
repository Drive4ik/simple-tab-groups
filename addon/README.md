## Instructions for Mozilla reviewers

```bash
$ npm install
$ npm run build-zip
```

A `dist-zip` folder will be created in which there will be 2 archives - one with minimized files for production and the other with source code.

If you need the build without minimization code you need to run the command
```bash
$ npm install
$ npm run build
```
This code will be located in the `dist` folder.
