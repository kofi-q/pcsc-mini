const assert = require("node:assert");
const { describe, mock, test } = require("node:test");

const { Client } = require("./client");
const {
  ReaderStatus,
  ReaderStatusFlags,
  readerStatusString,
} = require("./reader");

/** @import pcsc from "./addon.node"  */
/** @import { Err } from "./client"  */
/** @import { Reader } from "./reader"  */

describe("Client", () => {
  test("reader()", async () => {
    const mockClient = /** @type {pcsc.Client} */ ({
      start(onStateChange, _onError) {
        onStateChange(
          "iReadCards",
          ReaderStatus.PRESENT,
          Uint8Array.of(0xca, 0xfe),
        );
        onStateChange(
          "iReadCards v2.0",
          ReaderStatus.PRESENT,
          Uint8Array.of(0xf0, 0x0d),
        );
      },
    });

    const mockAddon = /** @type {pcsc} */ ({ newClient: () => mockClient });

    const client = new Client(mockAddon);
    assert.equal(client.reader("foo"), undefined);
    assert.equal(client.reader("iReadCards"), undefined);
    assert.equal(client.reader("iReadCards v2.0"), undefined);

    client.start();
    assert.equal(client.reader("foo"), undefined);

    const reader1 = client.reader("iReadCards");
    assert(reader1);
    assert.equal(reader1.name(), "iReadCards");

    const reader2 = client.reader("iReadCards v2.0");
    assert(reader2);
    assert.equal(reader2.name(), "iReadCards v2.0");
  });

  test("running() - updated on start/stop", () => {
    const mockStart = test.mock.fn();
    const mockStop = test.mock.fn();
    const mockClient = /** @type {pcsc.Client} */ ({
      start: (_onChange, _onErr) => mockStart(),
      stop: () => mockStop(),
    });

    const client = new Client(
      /** @type {pcsc} */ ({ newClient: () => mockClient }),
    );

    assert.equal(client.running(), false);

    client.start();
    assert.equal(client.running(), true);

    client.stop();
    assert.equal(client.running(), false);

    client.start();
    assert.equal(client.running(), true);

    client.stop();
    assert.equal(client.running(), false);

    assert.equal(mockStart.mock.callCount(), 2);
    assert.equal(mockStop.mock.callCount(), 2);
  });

  test("stop() - emits disconnect events", () => {
    /** @type {pcsc.ReaderChangeHandler | undefined} */
    let onChange;

    const mockClient = /** @type {pcsc.Client} */ ({
      start(onChangeFn, _onErr) {
        onChange = onChangeFn;
      },
      stop() {},
    });

    const client = new Client(
      /** @type {pcsc} */ ({ newClient: () => mockClient }),
    );

    /** @type {Reader[]} */
    let readers = [];

    client.on("reader", r => readers.push(r));
    client.start();
    assert(onChange);

    const emptyAtr = Uint8Array.of();
    onChange("Reader A", ReaderStatus.EMPTY, emptyAtr);
    onChange("Reader B", ReaderStatus.EMPTY, emptyAtr);
    onChange("Reader C", ReaderStatus.EMPTY, emptyAtr);

    // Simulate disconnect for reader B:
    onChange("Reader B", ReaderStatus.UNKNOWN, emptyAtr);

    assert.equal(readers.length, 3);

    const onReaderDisconnect = test.mock.fn();
    for (const reader of readers) {
      reader.on("disconnect", () => onReaderDisconnect(reader.name()));
    }

    client.stop();
    assert.equal(onReaderDisconnect.mock.callCount(), 2);
    assert.deepEqual(onReaderDisconnect.mock.calls[0].arguments, ["Reader A"]);
    assert.deepEqual(onReaderDisconnect.mock.calls[1].arguments, ["Reader C"]);
  });

  test("emits reader detection events", async () => {
    /** @type {pcsc.ReaderChangeHandler | undefined} */
    let onStateChange;

    const mockClient = /** @type {pcsc.Client} */ ({
      start(onChange, _onErr) {
        onStateChange = onChange;
      },
    });

    const client = new Client(
      /** @type {pcsc} */ ({
        newClient: () => mockClient,
      }),
    );

    /** @type {Reader | undefined} */
    let reader;

    /** @type {ReaderStatusFlags | undefined} */
    let initialStatus;

    /** @type {Uint8Array | undefined} */
    let initialAtr;

    client.on("reader", r => {
      reader = r;
      r.once("change", (status, atr) => {
        initialAtr = atr;
        initialStatus = status;
      });
    });

    client.start();
    assert(onStateChange);
    assert.equal(reader, undefined);

    onStateChange("iReadCards", ReaderStatus.EMPTY, Uint8Array.of(0xca, 0xfe));
    assert(reader);
    assert.equal(reader.name(), "iReadCards");
    assert.deepEqual(initialStatus, new ReaderStatusFlags(ReaderStatus.EMPTY));
    assert.deepEqual(initialAtr, Uint8Array.of(0xca, 0xfe));
  });

  test("emits error events", async () => {
    /** @type {Err} */
    const mockErr = {
      code: "NoService",
      message: "PCSC service not running",
      name: "",
    };

    /** @type {pcsc.ErrorHandler | undefined} */
    let onError;

    const mockStop = test.mock.fn();
    const mockClient = /** @type {pcsc.Client} */ ({
      start(_onChange, onErr) {
        onError = onErr;
      },
      stop: () => mockStop(),
    });

    const client = new Client(
      /** @type {pcsc} */ ({ newClient: () => mockClient }),
    );

    const mockOnError = mock.fn(
      /** @param {Err} err  */
      err => assert.strictEqual(err, mockErr),
    );
    client.on("error", mockOnError);
    assert.equal(mockOnError.mock.callCount(), 0);
    assert.equal(onError, undefined);

    client.start();
    assert(onError);

    onError(mockErr);
    assert.equal(mockOnError.mock.callCount(), 1);
    assert.equal(mockStop.mock.callCount(), 0);

    mockOnError.mock.resetCalls();

    client.stop();
    assert.equal(mockStop.mock.callCount(), 1);

    // Should ignore potential shutdown errors after stopping.
    onError(mockErr);
    assert.equal(mockOnError.mock.callCount(), 0);
  });

  test("emits initial reader status event", async () => {
    /** @type {pcsc.ReaderChangeHandler | undefined} */
    let onStateChange;

    const mockClient = /** @type {pcsc.Client} */ ({
      start(onChange, _onErr) {
        onStateChange = onChange;
      },
    });

    const mockAtr = Uint8Array.of(0xca, 0xfe);
    const mockStatusRaw = ReaderStatus.PRESENT | ReaderStatus.IN_USE;
    const mockOnChange = mock.fn(
      /**
       * @param {ReaderStatusFlags} status
       * @param {Uint8Array} atr
       */
      (status, atr) => {
        assert.deepEqual(status, new ReaderStatusFlags(mockStatusRaw));
        assert.strictEqual(atr, mockAtr);
      },
    );

    const client = new Client(
      /** @type {pcsc} */ ({ newClient: () => mockClient }),
    );

    /** @type {Reader | undefined} */
    let reader;

    client.on("reader", r => {
      reader = r;
      reader.on("change", mockOnChange);
    });

    client.start();
    assert(onStateChange);
    assert.equal(reader, undefined);

    onStateChange("iReadCards", mockStatusRaw, mockAtr);
    assert(reader);

    assert.equal(mockOnChange.mock.callCount(), 1);
  });

  test("emits reader status events", async () => {
    /** @type {pcsc.ReaderChangeHandler | undefined} */
    let onStateChange;

    const mockClient = /** @type {pcsc.Client} */ ({
      start(onChange, _onErr) {
        onStateChange = onChange;
      },
    });

    const client = new Client(
      /** @type {pcsc} */ ({ newClient: () => mockClient }),
    );

    /** @type {Reader | undefined} */
    let reader;

    client.on("reader", r => (reader = r)).start();
    assert(onStateChange);

    // Set up initial detection state change:
    onStateChange("iReadCards", ReaderStatus.EMPTY, Uint8Array.of());
    assert(reader);

    const mockAtr = Uint8Array.of(0xca, 0xfe);
    const mockStatusRaw = ReaderStatus.PRESENT | ReaderStatus.IN_USE;
    const mockOnChange = mock.fn(
      /**
       * @param {ReaderStatusFlags} status
       * @param {Uint8Array} atr
       */
      (status, atr) => {
        assert.deepEqual(status, new ReaderStatusFlags(mockStatusRaw));
        assert.strictEqual(atr, mockAtr);
      },
    );

    reader.on("change", mockOnChange);
    assert.equal(mockOnChange.mock.callCount(), 0);

    client.removeAllListeners("reader");
    onStateChange("other reader", mockStatusRaw, mockAtr);
    assert.equal(mockOnChange.mock.callCount(), 0);

    onStateChange("iReadCards", mockStatusRaw, mockAtr);
    assert.equal(mockOnChange.mock.callCount(), 1);
  });

  /** @type {ReaderStatus[]} */
  const DISCONNECTION_STATUSES = [
    ReaderStatus.UNKNOWN,
    ReaderStatus.UNAVAILABLE,
  ];

  for (const status of DISCONNECTION_STATUSES) {
    const statusName = readerStatusString(status);

    test(`emits reader disconnect events for ${statusName}`, async () => {
      /** @type {pcsc.ReaderChangeHandler | undefined} */
      let onStateChange;

      const mockClient = /** @type {pcsc.Client} */ ({
        start(onChange, _onErr) {
          onStateChange = onChange;
        },
      });

      const client = new Client(
        /** @type {pcsc} */ ({
          newClient: () => mockClient,
        }),
      );

      /** @type {Reader | undefined} */
      let reader;

      client.on("reader", r => (reader = r)).start();
      assert(onStateChange);

      onStateChange("iReadCards", ReaderStatus.EMPTY, Uint8Array.of());
      assert(reader);

      const mockOnChange = mock.fn();
      const mockOnDisconnect = mock.fn();

      reader.on("change", mockOnChange);
      reader.on("disconnect", mockOnDisconnect);
      assert.equal(mockOnDisconnect.mock.callCount(), 0);

      onStateChange("other reader", status, Uint8Array.of());
      assert.equal(mockOnDisconnect.mock.callCount(), 0);

      onStateChange("iReadCards", status, Uint8Array.of());
      assert.equal(mockOnDisconnect.mock.callCount(), 1);

      // Verify no further events emitted after disconnect:
      onStateChange("iReadCards", ReaderStatus.PRESENT, Uint8Array.of());
      assert.equal(mockOnDisconnect.mock.callCount(), 1);
      assert.equal(mockOnChange.mock.callCount(), 0);
    });
  }
});
