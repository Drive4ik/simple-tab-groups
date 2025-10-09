
export default class BatchProcessor {
    #batches = new Map;
    #processCallback;
    #processEmpty;
    #batchDelay;

    constructor(processCallback, processEmpty = false, batchDelay = 100) {
        this.#processCallback = processCallback;
        this.#processEmpty = processEmpty;
        this.#batchDelay = batchDelay;
    }

    #processBatch(id) {
        const batch = this.#batches.get(id);
        this.#batches.delete(id);

        if (this.#processEmpty || batch?.items.size) {
            this.#processCallback(id, Array.from(batch.items));
        }
    }

    add(id, item) {
        if (!id) {
            throw Error('id is required');
        }

        let batch = this.#batches.get(id);

        if (!batch) {
            batch = {
                items: new Set,
                timer: null,
            };
            this.#batches.set(id, batch);
        }

        batch.items.add(item);

        clearTimeout(batch.timer);
        batch.timer = setTimeout(() => this.#processBatch(id), this.#batchDelay);
    }

    delete(id, item) {
        this.#batches.get(id)?.items.delete(item);
    }

    flush() {
        for (const [id, batch] of this.#batches) {
            clearTimeout(batch.timer);
            this.#processBatch(id);
        }
    }
}
