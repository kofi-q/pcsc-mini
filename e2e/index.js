const assert = require("node:assert");
const readline = require("node:readline");

const { Chalk } = require("chalk");
const pcsc = require("pcsc-mini");
const {
  CardDisposition,
  CardMode,
  ReaderStatus,
  ReaderStatusFlags,
} = require("pcsc-mini");

const { Logger } = require("./logger");

const client = new pcsc.Client()
  .on("reader", r => new Reader(r))
  .on("error", onError)
  .start();

console.log("\nMonitoring started...");

listenForHotkeys();

class Reader {
  /** @type {"busy" | pcsc.Card | undefined} */
  #card;

  #chalk = takeChalk();

  /** @type {ReaderStatusFlags} */
  #lastStatus = new ReaderStatusFlags(0);

  #log = new Logger(this.#chalk);

  /** @type {pcsc.Reader} */
  #reader;

  #responseBuffer = new ArrayBuffer(pcsc.MAX_BUFFER_LEN);

  /**
   * @param {pcsc.Reader} reader
   */
  constructor(reader) {
    this.#reader = reader;
    this.#reader.on("change", this.onChange);
    this.#reader.on("disconnect", this.onDisconnect);

    this.#log.logNow(`\n${this.printName()}`, `\nReader detected`);
  }

  onDisconnect = async () => {
    this.#log.log(`\n${this.printName()}`, `\nReader disconnected`);

    if (this.#card && this.#card !== "busy") {
      this.#log.log("\n    ┗━ Stale card connection found. Disconnecting...");

      try {
        const card = this.#card;
        this.#card = undefined;

        await card.disconnect(CardDisposition.RESET);

        this.#log.logNow("🟢");
      } catch (err) {
        this.#log.logNow("\n      ┗━ 🔴", err);
      }
    }

    this.#log.flush();
    giveChalk(this.#chalk);
  };

  /**
   * @param {ReaderStatusFlags} status
   */
  onChange = async status => {
    this.#log.log(`\n${this.printName()}`, `\nReader state changed: `);
    this.#log.log(`${this.#lastStatus} -> ${status}`);

    this.#lastStatus = status;

    if (status.has(ReaderStatus.MUTE)) {
      this.#log.logNow("\n  ┗━ No card contact. Ignoring.");
      return;
    }

    if (
      status.hasAny(ReaderStatus.IN_USE, ReaderStatus.EXCLUSIVE) ||
      this.#card === "busy"
    ) {
      this.#log.flush();
      return;
    }

    if (status.has(ReaderStatus.EMPTY)) {
      if (this.#card) {
        this.#log.log("\n  ┗━ Card removed. Disconnecting...");

        try {
          const card = this.#card;
          this.#card = undefined;

          await card.disconnect(CardDisposition.RESET);

          this.#log.logNow("🟢");
        } catch (err) {
          this.#log.logNow("\n      ┗━ 🔴", err);
        }
      }

      this.#log.flush();
      return;
    }

    if (!status.has(ReaderStatus.PRESENT)) {
      this.#log.logNow(`\n  ┗━ 🔴 Unhandled status: ${status}`);
      return;
    }

    try {
      if (!this.#card) {
        this.#log.logNow("\n  ┗━ Card inserted. Connecting in SHARED mode...");

        this.#card = "busy";
        this.#card = await this.#reader.connect(CardMode.SHARED);

        this.#log.logNow(
          `\n${this.printName()}`,
          "\n🟢 Card connected",
          "\n  ┗━ Protocol:",
          pcsc.protocolString(this.#card.protocol()),
        );
      }
    } catch (err) {
      this.#log.logNow(
        `\n${this.printName()}`,
        `\n🔴 Card connection failed:`,
        err,
      );

      this.#card = undefined;

      return;
    }

    try {
      this.#log.log(`\n${this.printName()}\nGetting card state...`);

      const state = await this.withLock(card => card.state());

      this.#log.logNow(`\n  ┗━ 🟢 ${state}`);
    } catch (err) {
      this.#log.logNow("\n  ┗━ 🔴 Failed:", err);

      if (errCode(err) === "NoSmartCard") return;
    }

    try {
      const cmd = Uint8Array.of(0x00, 0xa4, 0x04, 0x00, 0x02, 0x3f, 0x00);
      this.#log.log(
        `\n${this.printName()}`,
        `\nTest transmission: ${byteString(cmd)}`,
      );

      const response = await this.withLock(card =>
        card.transmit(cmd, this.#responseBuffer),
      );

      this.#log.logNow("\n  ┗━ 🟢 Response:", byteString(response));
    } catch (err) {
      this.#log.logNow("\n  ┗━ 🔴 Failed:", err);

      if (errCode(err) === "NoSmartCard") return;
    }

    /** @type {Uint8Array} */
    let response;

    /** @type {pcsc.Transaction} */
    let txn;

    try {
      this.#log.log(`\n${this.printName()}`, `\nStarting transaction...`);

      txn = await this.withLock(card => card.transaction());

      this.#log.logNow("\n  ┗━ 🟢 Transaction started.");
    } catch (err) {
      this.#log.logNow("\n  ┗━ 🔴 Failed:", err);

      return;
    }

    try {
      const ctrlCode = pcsc.controlCode(3400);
      this.#log.log(
        `\n${this.printName()}`,
        `\nSending control code: 0x${ctrlCode.toString(16)}...`,
      );

      response = await this.withLock(card =>
        card.control(ctrlCode, undefined, this.#responseBuffer),
      );

      this.#log.logNow("\n  ┗━ 🟢 Response:", byteString(response));
    } catch (err) {
      this.#log.logNow("\n  ┗━ 🔴 Failed:", err);

      if (errCode(err) === "NoSmartCard") return;
    }

    try {
      const ATR_STRING = pcsc.attributes.ids.ATR_STRING;
      this.#log.log(
        `\n${this.printName()}`,
        `\nGetting attribute: 0x${ATR_STRING.toString(16)}...`,
      );

      response = await this.withLock(card =>
        card.attributeGet(ATR_STRING, this.#responseBuffer),
      );

      this.#log.logNow("\n  ┗━ 🟢 Response:", byteString(response));
    } catch (err) {
      this.#log.logNow("\n  ┗━ 🔴 Failed:", err);

      if (errCode(err) === "NoSmartCard") return;
    }

    try {
      const VENDOR_NAME = pcsc.attributes.ids.VENDOR_NAME;
      this.#log.log(
        `\n${this.printName()}`,
        `\nSetting attribute: 0x${VENDOR_NAME.toString(16)} to "foo"...`,
      );

      await this.withLock(card =>
        card.attributeSet(
          pcsc.attributes.ids.VENDOR_NAME,
          Uint8Array.from(["f", "o", "o"]),
        ),
      );

      this.#log.logNow("\n  ┗━ 🟢 Attribute set.");
    } catch (err) {
      this.#log.logNow("\n  ┗━ 🔴 Failed:", err);

      if (errCode(err) === "NoSmartCard") return;
    }

    try {
      this.#log.log(`\n${this.printName()}`, `\nEnding transaction...`);

      await this.withLock(() => txn.end(CardDisposition.LEAVE));

      this.#log.logNow("\n  ┗━ 🟢 Transaction ended.");
    } catch (err) {
      this.#log.logNow("\n  ┗━ 🔴 Failed:", err);

      if (errCode(err) === "NoSmartCard") return;
    }

    try {
      this.#log.logNow(
        `\n${this.printName()}`,
        `\nAttempting reconnect in EXCLUSIVE mode...`,
      );

      const newProto = await this.withLock(card =>
        card.reconnect(pcsc.CardMode.EXCLUSIVE, pcsc.CardDisposition.LEAVE),
      );

      this.#log.logNow(
        `\n${this.printName()}`,
        "\n🟢 Reconnected in EXCLUSIVE mode with protocol:",
        pcsc.protocolString(newProto),
      );
    } catch (err) {
      this.#log.logNow(
        `\n${this.printName()}`,
        "\n  ┗━ 🔴 Reconnect failed:",
        err,
      );

      if (errCode(err) === "NoSmartCard") return;
    }
  };

  /**
   * @template T
   * @param {(card: pcsc.Card) => Promise<T>} fn
   */
  async withLock(fn) {
    assert(this.#card instanceof pcsc.Card);
    const card = this.#card;
    this.#card = "busy";

    try {
      return await fn(card);
    } finally {
      this.#card = card;
    }
  }

  printName() {
    return this.#chalk.bold.underline(`[${this.#reader}]`);
  }
}

/**
 * @param {pcsc.Err} err
 */
function onError(err) {
  console.error("Unexpected pcsc error:", err);
  exit(1);
}

/**
 * @param {unknown} err
 */
function errCode(err) {
  if (err instanceof Error && "code" in err) {
    return err.code;
  }

  return undefined;
}

/**
 * @param {number} code
 * @returns {never}
 */
function exit(code) {
  console.log(`\nExit triggered. Stopping client monitoring...`);
  client.stop();
  process.exit(code);
}

/**
 * @param {Uint8Array} buf
 */
function byteString(buf) {
  const chunks = new Array(buf.length);

  for (let i = 0; i < buf.length; i += 1) {
    chunks[i] = buf[i].toString(16);
  }

  return chunks.join(", ");
}

const chalk = new Chalk();
const chalks = [
  chalk.yellow, //
  chalk.magenta, //
  chalk.blue, //
  chalk.white, //
];

function takeChalk() {
  const ch = chalks.pop();
  assert(ch);
  return ch;
}

/** @param {typeof chalk} ch  */
function giveChalk(ch) {
  chalks.push(ch);
}

function listenForHotkeys() {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on("keypress", async (key, data) => {
    switch (key) {
      case "s": {
        if (!client.running()) {
          console.log("Start requested. Resuming monitoring thread...");
          client.start();

          break;
        }

        console.log("Stop requested. Shutting down monitoring thread...");
        client.stop();

        break;
      }

      default: {
        if (data.ctrl && data.name === "c") process.exit(0);
        break;
      }
    }
  });
}
