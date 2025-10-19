
export default class BatchProcessor {
    #batches = new Map;
    #queue = new Set;
    #processing = false;
    #processCallback;
    #processEmpty;
    #batchDelay;

    constructor(processCallback, processEmpty = false, batchDelay = 100) {
        this.#processCallback = processCallback;
        this.#processEmpty = processEmpty;
        this.#batchDelay = batchDelay;
    }

    async #processQueue() {
        if (this.#processing) {
            return;
        }

        this.#processing = true;

        while (this.#queue.size) {
            const [batch] = this.#queue;
            this.#queue.delete(batch);

            if (batch.items.size || this.#processEmpty) {
                await this.#processCallback(batch.id, Array.from(batch.items));
            }
        }

        this.#processing = false;
    }

    #addQueue(...batches) {
        for (const batch of batches) {
            clearTimeout(batch.timer);
            this.#batches.delete(batch.id);
            this.#queue.add(batch);
        }
        this.#processQueue();
    }

    add(id, item) {
        if (!id) {
            throw Error('id is required');
        }

        let batch = this.#batches.get(id);

        if (!batch) {
            batch = {
                id,
                items: new Set,
                timer: null,
            };
            this.#batches.set(id, batch);
        }

        batch.items.add(item);

        clearTimeout(batch.timer);
        batch.timer = setTimeout(() => this.#addQueue(batch), this.#batchDelay);
    }

    delete(id, item) {
        this.#batches.get(id)?.items.delete(item);
    }

    flush() {
        this.#addQueue(...this.#batches.values());
    }
}
