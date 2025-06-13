const assert = require("node:assert");
const { describe, test } = require("node:test");

const { CardMode, Protocol } = require("./card");
const { Reader, ReaderStatus, ReaderStatusFlags } = require("./reader");

/** @import pcsc from "./addon.node"  */

describe("Reader", () => {
  test("connect() - explicit protocol", async () => {
    const mockCard = /** @type {pcsc.Card} */ ({
      protocol() {
        return Protocol.T0;
      },
    });

    const mockClient = /** @type {pcsc.Client} */ ({
      connect(readerName, mode, protocol) {
        assert.equal(readerName, "iReadCards");
        assert.equal(mode, CardMode.EXCLUSIVE);
        assert.equal(protocol, Protocol.T1);

        return Promise.resolve(mockCard);
      },
    });

    const reader = new Reader(mockClient, "iReadCards");
    const card = await reader.connect(CardMode.EXCLUSIVE, Protocol.T1);
    assert.equal(card.protocol(), Protocol.T0);
  });

  test("connect() - protocol omitted", async () => {
    const mockCard = /** @type {pcsc.Card} */ ({
      protocol() {
        return Protocol.T1;
      },
    });

    const mockClient = /** @type {pcsc.Client} */ ({
      connect(readerName, mode, protocol) {
        assert.equal(readerName, "iReadCards");
        assert.equal(mode, CardMode.SHARED);
        assert.equal(protocol, undefined);

        return Promise.resolve(mockCard);
      },
    });

    const reader = new Reader(mockClient, "iReadCards");
    const card = await reader.connect(CardMode.SHARED);
    assert.equal(card.protocol(), Protocol.T1);
  });

  test("name()", () => {
    assert.equal(
      new Reader(/** @type {pcsc.Client} */ ({}), "iReadCards").name(),
      "iReadCards",
    );
  });

  test("toString()", () => {
    assert.equal(
      new Reader(/** @type {pcsc.Client} */ ({}), "iReadCards").toString(),
      "iReadCards",
    );
  });
});

describe("ReaderStatusFlags", () => {
  test("has()", () => {
    const none = new ReaderStatusFlags(0);
    assert.equal(none.has(ReaderStatus.CHANGED), false);

    const changedPresent = new ReaderStatusFlags(
      ReaderStatus.CHANGED | ReaderStatus.PRESENT,
    );
    assert.equal(changedPresent.has(ReaderStatus.CHANGED), true);
    assert.equal(changedPresent.has(ReaderStatus.PRESENT), true);
    assert.equal(
      changedPresent.has(ReaderStatus.PRESENT, ReaderStatus.CHANGED),
      true,
    );
    assert.equal(
      changedPresent.has(ReaderStatus.PRESENT, ReaderStatus.MUTE),
      false,
    );
  });

  test("hasAny()", () => {
    const none = new ReaderStatusFlags(0);
    assert.equal(none.hasAny(ReaderStatus.CHANGED), false);

    const changedPresent = new ReaderStatusFlags(
      ReaderStatus.CHANGED | ReaderStatus.PRESENT,
    );
    assert.equal(changedPresent.hasAny(ReaderStatus.CHANGED), true);
    assert.equal(changedPresent.hasAny(ReaderStatus.PRESENT), true);
    assert.equal(
      changedPresent.hasAny(ReaderStatus.PRESENT, ReaderStatus.CHANGED),
      true,
    );
    assert.equal(
      changedPresent.hasAny(ReaderStatus.PRESENT, ReaderStatus.MUTE),
      true,
    );
  });

  test("toString()", () => {
    const none = new ReaderStatusFlags(0);
    assert.equal(none.toString(), "{ }");

    const present = new ReaderStatusFlags(ReaderStatus.PRESENT);
    assert.equal(present.toString(), "{ PRESENT }");

    const changedPresentEmpty = new ReaderStatusFlags(
      ReaderStatus.CHANGED | ReaderStatus.PRESENT | ReaderStatus.EMPTY,
    );
    assert.equal(changedPresentEmpty.toString(), "{ EMPTY | PRESENT }");
  });
});
