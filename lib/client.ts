import { EventEmitter } from "node:events";

import * as pcsc from "./addon.node";
import { type Err } from "./addon.node";
import { Reader, ReaderStatus, ReaderStatusFlags } from "./reader";

export { type Err };

export import MAX_READERS = pcsc.MAX_READERS;

/**
 * Represents a PCSC client connection. Provides notifications for reader
 * connection state changes via an {@link EventEmitter} interface.
 *
 * ## Events
 * - **`"error"` [ {@link Err} ]** - Emitted when an error is encountered
 *   while monitoring for reader state updates in the background thread.
 * - **`"reader"` [ {@link Reader} ]** - Emitted once for each card reader when
 *   it is detected (connected/re-connected to the system) and also once for
 *   each reader that is already connected when monitoring is {@link start}ed.
 *
 * ## Example
 * ```ts
 * import * as pcsc from "pcsc-mini";
 *
 * const client = new pcsc.Client()
 *   .on("reader", onReader);
 *   .on("error", onError);
 *   .start(); // Start monitoring for reader state changes.
 *
 * function onError(err: pcsc.Err) {
 *   console.error("Unexpected PCSC error:", err);
 *   client.stop();
 * };
 *
 * function onReader(reader: pcsc.Reader) {
 *   console.log(`Reader detected: ${reader}`);
 *   // ...
 * }
 * ```
 */
export class Client extends EventEmitter<{
  error: [Err];
  reader: [Reader];
}> {
  readonly #client: pcsc.Client;
  readonly #readers: Record<string, Reader> = {};
  #running = false;

  constructor(addon = pcsc) {
    super();
    this.#client = addon.newClient();
  }

  /**
   * The reader identified by `name`, if it is currently connected.
   */
  reader(name: string): Reader | undefined {
    return this.#readers[name];
  }

  /**
   * `true` if the reader state monitoring thread is currently running.
   */
  running(): boolean {
    return this.#running;
  }

  /**
   * Start monitoring for reader status changes.
   *
   * A subsequent call to {@link stop} will stop monitoring and detach
   * this client.
   *
   * @throws {@link Err}
   */
  start(): Client {
    this.#running = true;
    this.#client.start(this.#onStateChange, this.#onError);

    return this;
  }

  /**
   * Stop monitoring for reader status changes and detach the client from the
   * PCSC server. Any in-progress transmissions will be cancelled.
   *
   * Monitoring can be resumed with another call to {@link start};
   *
   * @throws {@link Err}
   */
  stop(): void {
    this.#running = false;
    this.#client.stop();

    for (const name of Object.keys(this.#readers)) {
      this.#onReaderDisconnect(name);
    }
  }

  #onError = (err: Err) => {
    // Ignore shutdown errors when the monitoring thread is stopped.
    if (!this.#running) return;

    this.emit("error", err);
  };

  #onReaderConnect = (name: string): Reader => {
    const existingReader = this.#readers[name];
    if (existingReader) return existingReader;

    const reader = new Reader(this.#client, name);
    this.#readers[name] = reader;
    this.emit("reader", reader);

    return reader;
  };

  #onReaderDisconnect = (name: string) => {
    if (!this.#readers[name]) return;

    this.#readers[name].emit("disconnect");
    this.#readers[name].removeAllListeners();
    delete this.#readers[name];
  };

  #onStateChange: pcsc.ReaderChangeHandler = (readerName, rawStatus, atr) => {
    const status = new ReaderStatusFlags(rawStatus);

    if (status.hasAny(ReaderStatus.UNKNOWN, ReaderStatus.UNAVAILABLE)) {
      return this.#onReaderDisconnect(readerName);
    }

    this.#onReaderConnect(readerName).emit("change", status, atr);
  };
}
