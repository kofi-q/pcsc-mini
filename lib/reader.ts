import { EventEmitter } from "node:events";

import * as pcsc from "./addon.node";
import { type Err } from "./addon.node";
import { Card, CardMode, Protocol } from "./card";

export { type Err };

export import ReaderStatus = pcsc.ReaderStatus;
export import readerStatusString = pcsc.readerStatusString;

/**
 * Represents a connected card reader. Provides an API for connecting to
 * inserted cards and an {@link EventEmitter} interface for reader/card state
 * notifications.
 *
 * ## Events
 * - **`"change"` [ {@link ReaderStatusFlags}, {@link Uint8Array} ]** - Emitted
 *   when a change is detected in the state of the reader. The event handler is
 *   invoked with the new reader status and
 *   [ATR](https://en.wikipedia.org/wiki/Answer_to_reset) value of the inserted
 *   card, if present.
 * - **`"disconnect"` [ _no args_ ]** - Emitted when the reader is no longer
 *   detected (e.g. physically disconnected from the system).
 *
 * ## Example
 *
 * ```ts
 * import * as pcsc from "pcsc-mini";
 * const { CardDisposition, CardMode, ReaderStatus } = pcsc;
 *
 * const client = new pcsc.Client()
 *   .on("reader", onReader)
 *   .start();
 *
 * function onReader(reader: pcsc.Reader) {
 *   let card: pcsc.Card | undefined;
 *
 *   reader.on("change", async status => {
 *     if (!status.has(ReaderStatus.PRESENT)) return;
 *     if (status.hasAny(ReaderStatus.MUTE, ReaderStatus.IN_USE)) return;
 *
 *     if (!card) card = await reader.connect(CardMode.SHARED);
 *
 *     // ...
 *   });
 *
 *   reader.on("disconnect", () => {
 *     void card?.disconnect(CardDisposition.RESET);
 *     card = undefined;
 *   });
 * }
 * ```
 */
export class Reader extends EventEmitter<{
  change: [ReaderStatusFlags, Uint8Array];
  disconnect: [];
}> {
  readonly #client: pcsc.Client;
  readonly #name: string;

  constructor(client: pcsc.Client, name: string) {
    super();

    this.#client = client;
    this.#name = name;
  }

  /**
   * Establishes a new connection with an inserted card, if available, with the
   * specified protocol (or an appropriate one for the card, if unspecified).
   *
   * {@link Protocol.UNSET} can be used only in conjunction with
   * {@link CardMode.DIRECT} and will cause the connection to be made without
   * any protocol negotiation. A protocol can subsequently be set via
   * {@link Card.control} with the `IOCTL_SMARTCARD_SET_PROTOCOL` control code -
   * i.e. {@link pcsc.controlCode}(12).
   *
   * See https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardconnecta#parameters
   *
   * @param mode - Access mode for the connection.
   * @param protocol - Preferred protocol for the connection. Defaults to
   *   {@link Protocol.ANY}.
   *
   * @returns The newly connected card.
   * @throws {@link Err}
   */
  async connect(mode: CardMode, protocol?: Protocol): Promise<Card> {
    try {
      return new Card(await this.#client.connect(this.#name, mode, protocol));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * The driver-provided reader name.
   *
   * > [!NOTE]
   * > If multiple readers of the same model are connected, this will be
   * > disambiguated (e.g. `"FOO Inc Reader 00"`, `"FOO Inc Reader 01"`), but
   * > the assigned index is not guaranteed to be consistent across
   * > disconnects/reconnects.
   */
  name(): string {
    return this.#name;
  }

  /**
   * Alias of {@link name}.
   */
  toString(): string {
    return this.#name;
  }
}

/**
 * Bit flag representation of a card reader's status.
 */
export class ReaderStatusFlags {
  /** The raw mask value of the status flags. */
  readonly raw: number;

  constructor(raw: number) {
    this.raw = raw;
  }

  /**
   * `true` iff *all* the specified flags are set.
   */
  has(...flags: readonly ReaderStatus[]): boolean {
    let mask = 0;
    for (const flag of flags) mask |= flag;

    return (this.raw & mask) === mask;
  }

  /**
   * `true` if *any* of the specified flags are set.
   */
  hasAny(...flags: readonly ReaderStatus[]): boolean {
    let mask = 0;
    for (const flag of flags) mask |= flag;

    return (this.raw & mask) !== 0;
  }

  /**
   * Human-readable names of the enabled flags, for logging/debugging.
   */
  toString(): string {
    return readerStatusString(this.raw);
  }
}
