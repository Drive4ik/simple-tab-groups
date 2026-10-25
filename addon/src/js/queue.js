import * as QueueCore from './queue-core.js';

const STUCK_AFTER = 30_000;

export default class Queue {
    #name;
    #trace;
    #stuckAfter;
    #tails = new Map; // key → the release of the last turn
    #live = new WeakSet; // the turns handed out and not released yet

    constructor(name, {trace = true, stuckAfter = STUCK_AFTER} = {}) {
        QueueCore.registerQueue(name);

        this.#name = name;
        this.#trace = trace;
        this.#stuckAfter = stuckAfter;
    }

    // the turn of the queue, released by `using` (docs/DESIGN-QUEUES.md §1): a live turn of this queue
    // and key in outerTurn means the caller already runs inside a turn - the same turn is handed out
    // and held by one more block. stuckAfter - ms before the watch logs the turn as stuck (§5)
    async wait(name, outerTurn = null, {key = null, stuckAfter = this.#stuckAfter} = {}) {
        if (this.#live.has(outerTurn) && outerTurn.key === key) {
            outerTurn.holders++;
            return outerTurn;
        }

        const entry = QueueCore.enter({
            label: `${this.constructor.name}.${this.#name}${key ? `[${key}]` : ''}.${name}`,
            stuckAfter,
            queue: this,
            key,
            trace: this.#trace ? new Error : null,
        }, QueueCore.STATE_WAITING);

        const {promise: released, resolve: release} = Promise.withResolvers();
        const previous = this.#tails.get(key);

        this.#tails.set(key, released);

        await previous;

        QueueCore.setState(entry, QueueCore.STATE_RUNNING);

        const turn = {
            key,
            holders: 1,
            [Symbol.dispose]: () => {
                if (--turn.holders) {
                    return;
                }

                release();

                this.#live.delete(turn);

                if (this.#tails.get(key) === released) {
                    this.#tails.delete(key);
                }

                QueueCore.leave(entry);
            },
        };

        this.#live.add(turn);

        return turn;
    }
}
