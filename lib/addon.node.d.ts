/**
 * Maximum number of bytes in an ATR value.
 */
export const MAX_ATR_LEN: number;

/**
 * Maximum number of bytes that can be sent/received in input/output buffers.
 */
export const MAX_BUFFER_LEN: number;

/**
 * Maximum number of connected readers that will be monitored by `pcsc-mini`.
 */
export const MAX_READERS: number;

/**
 * Card disposition action to perform when disconnecting or reconnecting.
 */
export enum CardDisposition {
  /** Eject the card. (Not currently supported by any known hardware.) */
  EJECT = 3,

  /** Do nothing. */
  LEAVE = 0,

  /** Reset the card (warm reset). */
  RESET = 1,

  /** Power down the card (cold reset). */
  UNPOWER = 2,
}

/**
 * Card connection mode.
 */
export enum CardMode {
  /**
   * Initiate direct connection to the reader without the need for a card to be
   * present. The connection is shared on Unix systems and exclusive on Windows.
   */
  DIRECT = 3,

  /**
   * No other processes will be able to access the reader until disconnected.
   */
  EXCLUSIVE = 1,

  /**
   * Other processes will be able access the reader as well.
   */
  SHARED = 2,
}

/**
 * Status of a card in a reader, if any.
 */
export enum CardStatus {
  ABSENT = 2,
  NEGOTIABLE = 32,
  POWERED = 16,
  PRESENT = 4,
  SPECIFIC = 64,
  SWALLOWED = 8,
  UNKNOWN = 1,
}

/**
 * Card communication protocol flags.
 */
export enum Protocol {
  /** The T=0 protocol. */
  T0 = 1,

  /** The T=1 protocol. */
  T1 = 2,

  /**
   * Used when specifying a preferred protocol to indicate that an appropriate
   * protocol for the card may be automatically selected.
   */
  ANY = T0 | T1,

  /**
   * Used with memory type cards. This value varies based on OS.
   *
   * Can be used in conjunction with {@link CardMode.DIRECT} for connecting with
   * no initial protocol negotiated (after which if must be manually set with an
   * appropriate reader control command).
   */
  RAW = number,

  /** The T=15 protocol. */
  T15 = 8,

  /**
   * No protocol set.
   */
  UNSET = 0,
}

/**
 * Status of connected (or previously connected) card reader.
 */
export enum ReaderStatus {
  ATR_MATCH = 64,
  CHANGED = 2,
  EMPTY = 16,
  EXCLUSIVE = 128,
  IGNORE = 1,
  IN_USE = 256,
  MUTE = 512,
  PRESENT = 32,
  UNAVAILABLE = 8,
  UNKNOWN = 4,
  UNPOWERED = 1024,
}

/**
 * Represents a card connection session created via {@link Client.connect}
 */
export interface Card {
  attributeGet(id: number, outputBuffer?: ArrayBuffer): Promise<Uint8Array>;

  attributeSet(id: number, value: Uint8Array): Promise<void>;
  control(
    code: number,
    command?: Uint8Array,
    outputBuffer?: ArrayBuffer,
  ): Promise<Uint8Array>;

  disconnect(then: CardDisposition): Promise<void>;

  protocol(): Protocol;

  reconnect(
    mode: CardMode,
    protocol?: Protocol,
    disposition: CardDisposition,
  ): Promise<void>;

  state(): Promise<CardState>;

  transaction(): Promise<Transaction>;

  transmit(
    protocol?: Protocol,
    input: Uint8Array,
    outputBuffer?: ArrayBuffer,
  ): Promise<Uint8Array>;
}

export interface CardState {
  atr: Uint8Array;
  protocol: Protocol;
  readerName: string;
  status: number;
}

export interface Client {
  connect(
    readerName: string,
    mode: CardMode,
    protocol?: Protocol,
  ): Promise<Card>;

  start(onStateChange: ReaderChangeHandler, onError: ErrorHandler): void;

  stop(): void;
}

/**
 * Error type thrown/rejected from native API calls and emitted by the
 * reader state background monitoring thread.
 */
export interface Err extends Error {
  /**
   * The associated error code. This may originate from `pcsc-mini`, the
   * underlying PCSC implementation, or the Node-API.
   */
  code: string;
}

export type ErrorHandler = (err: Err) => void;

/**
 * Event type emitted by the background monitoring thread on state changes.
 */
export interface ReaderState {
  atr: Uint8Array;
  name: string;
  status: number;
}

export type ReaderChangeHandler = (
  readerName: string,
  status: number,
  atr: Uint8Array,
) => void;

/**
 *
 * Represents a temporary {@link CardMode.EXCLUSIVE} connection session, which
 * can be started from a {@link CardMode.SHARED} connection via
 * {@link Card.transaction}().
 *
 * > [!IMPORTANT]
 * > {@link Transaction.end}() must be called when done.
 *
 * ## Example:
 * ```ts
 * import * as pcsc from "pcsc-mini";
 *
 * async function longRunningProcess(card: pcsc.Card) {
 *   const txn = card.transaction();
 *
 *   try {
 *     const r1 = await card.transmit(Uint8Array.of(0xca, 0xfe, 0xf0, 0x0d));
 *     const r2 = await card.transmit(Uint8Array.of(0xfa, 0xde, 0xfa, 0xce));
 *
 *     return processResults(r1, r2);
 *   } catch (err) {
 *     console.error("Something went wrong:", err);
 *   } finally {
 *     txn.end(pcsc.CardDisposition.LEAVE);
 *   }
 * }
 * ```
 */
export interface Transaction {
  /**
   * Closes the transaction and restores the previous card connection mode.
   *
   * @param then - The action to take after ending the transaction.
   *
   * @throws {@link Err}
   */
  end(then: CardDisposition): Promise<void>;
}

/**
 * Human-readable string representation of the given card status flags.
 *
 * @throws {@link Err}
 */
export function cardStatusString(rawStatus: number): string;

/**
 * Constructs a platform-specific PCSC reader control code
 * from the given function code.
 *
 * ## Example:
 * ```ts
 * import * as pcsc from "pcsc-mini";
 *
 * const IOCTL_GET_FEATURE_REQUEST = pcsc.controlCode(3400);
 *
 * function getFeatures(card: pcsc.Card): Promise<Uint8Array> {
 *   return card.control(IOCTL_GET_FEATURE_REQUEST);
 * }
 * ```
 *
 * @throws {@link Err}
 */
export function controlCode(functionCode: number): number;

/**
 * Creates a new {@link Client} - no connection is established with the PCSC
 * server until {@link Client.start} is called.
 *
 * @throws {@link Err}
 */
export function newClient(): Client;

/**
 * String representation of the given card connection protocol.
 *
 * @throws {@link Err}
 */
export function protocolString(protocol: Protocol): string;

/**
 * Human-readable string representation of the given reader status flags.
 *
 * @throws {@link Err}
 */
export function readerStatusString(rawStatus: number): string;

export namespace attributes {
  export enum Class {
    COMMUNICATIONS = 2,
    ICC_STATE = 9,
    IFD_PROTOCOL = 8,
    MECHANICAL = 6,
    POWER_MGMT = 4,
    PROTOCOL = 3,
    SECURITY = 5,
    SYSTEM = 32767,
    VENDOR_DEFINED = 7,
    VENDOR_INFO = 1,
  }

  export namespace ids {
    export const ASYNC_PROTOCOL_TYPES: number;
    export const ATR_STRING: number;
    export const CHANNEL_ID: number;
    export const CHARACTERISTICS: number;
    export const CURRENT_BWT: number;
    export const CURRENT_CLK: number;
    export const CURRENT_CWT: number;
    export const CURRENT_D: number;
    export const CURRENT_EBC_ENCODING: number;
    export const CURRENT_F: number;
    export const CURRENT_IFSC: number;
    export const CURRENT_IFSD: number;
    export const CURRENT_IO_STATE: number;
    export const CURRENT_N: number;
    export const CURRENT_PROTOCOL_TYPE: number;
    export const CURRENT_W: number;
    export const DEFAULT_CLK: number;
    export const DEFAULT_DATA_RATE: number;
    export const DEVICE_FRIENDLY_NAME: number;
    export const DEVICE_FRIENDLY_NAME_W: number;
    export const DEVICE_IN_USE: number;
    export const DEVICE_SYSTEM_NAME: number;
    export const DEVICE_SYSTEM_NAME_W: number;
    export const DEVICE_UNIT: number;
    export const ESC_AUTH_REQUEST: number;
    export const ESC_CANCEL: number;
    export const ESC_RESET: number;
    export const EXTENDED_BWT: number;
    export const ICC_INTERFACE_STATUS: number;
    export const ICC_PRESENCE: number;
    export const ICC_TYPE_PER_ATR: number;
    export const MAX_CLK: number;
    export const MAX_DATA_RATE: number;
    export const MAX_IFSD: number;
    export const MAX_INPUT: number;
    export const POWER_MGMT_SUPPORT: number;
    export const SUPPRESS_T1_IFS_REQUEST: number;
    export const SYNC_PROTOCOL_TYPES: number;
    export const USER_AUTH_INPUT_DEVICE: number;
    export const USER_TO_CARD_AUTH_DEVICE: number;
    export const VENDOR_IFD_SERIAL_NO: number;
    export const VENDOR_IFD_TYPE: number;
    export const VENDOR_IFD_VERSION: number;
    export const VENDOR_NAME: number;
  }
}
