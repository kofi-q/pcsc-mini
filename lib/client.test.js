const assert = require("node:assert");
const { describe, mock, test } = require("node:test");

const { Client } = require("./client");
const {
  Reader,
  ReaderStatus,
  ReaderStatusFlags,
  readerStatusString,
} = require("./reader");

/** @import pcsc from "./addon.node"  */
/** @import { Err } from "./client"  */

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

    const mockClient = /** @type {pcsc.Client} */ ({
      start(_onChange, onErr) {
        onErr(mockErr);
      },
    });

    const client = new Client(
      /** @type {pcsc} */ ({
        newClient: () => mockClient,
      }),
    );

    const mockOnError = mock.fn(
      /** @param {Err} err  */
      err => assert.strictEqual(err, mockErr),
    );
    client.on("error", mockOnError);
    assert.equal(mockOnError.mock.callCount(), 0);

    client.start();
    assert.equal(mockOnError.mock.callCount(), 1);
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

    const mockStatusRaw = ReaderStatus.PRESENT | ReaderStatus.IN_USE;
    const mockOnChange = mock.fn(
      /** @param {ReaderStatusFlags} status  */
      status => assert.deepEqual(status, new ReaderStatusFlags(mockStatusRaw)),
    );

    reader.on("change", mockOnChange);
    assert.equal(mockOnChange.mock.callCount(), 0);

    onStateChange("other reader", mockStatusRaw, Uint8Array.of());
    assert.equal(mockOnChange.mock.callCount(), 0);

    onStateChange("iReadCards", mockStatusRaw, Uint8Array.of());
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
