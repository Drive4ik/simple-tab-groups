
// polyfills: TC39 "upsert" proposal
// TODO remove after minimum FF 144+ in manifest.json
for (const proto of [Map.prototype, WeakMap.prototype]) {
    proto.getOrInsert ??= function(key, defaultValue) {
        if (!this.has(key)) {
            this.set(key, defaultValue);
        }

        return this.get(key);
    };

    proto.getOrInsertComputed ??= function(key, callback) {
        if (!this.has(key)) {
            this.set(key, callback(key));
        }

        return this.get(key);
    };
}
