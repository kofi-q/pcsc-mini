const assert = require("node:assert");
const { describe, mock, test } = require("node:test");

const {
  attributes,
  Card,
  CardDisposition,
  CardMode,
  CardStatus,
  CardStatusFlags,
  MAX_ATR_LEN,
  MAX_BUFFER_LEN,
  Protocol,
} = require("./card");

/** @import pcsc from "./addon.node"  */

describe("Card", () => {
  test("attributeGet", async () => {
    const buf = new ArrayBuffer(MAX_ATR_LEN);

    const mockResponse = Uint8Array.of(0xca, 0xfe);
    const mockCard = /** @type {pcsc.Card} */ ({
      attributeGet(id, outputBuffer) {
        assert.equal(id, attributes.ids.ATR_STRING);
        assert.strictEqual(outputBuffer, buf);

        return Promise.resolve(mockResponse);
      },
    });

    const card = new Card(mockCard);
    const res = await card.attributeGet(attributes.ids.ATR_STRING, buf);
    assert.strictEqual(res, mockResponse);
  });

  test("attributeGet - buffer omitted", async () => {
    const mockResponse = Uint8Array.of(0xca, 0xfe);
    const mockCard = /** @type {pcsc.Card} */ ({
      attributeGet(id, outputBuffer) {
        assert.equal(id, attributes.ids.ATR_STRING);
        assert.equal(outputBuffer, undefined);

        return Promise.resolve(mockResponse);
      },
    });

    const card = new Card(mockCard);
    const res = await card.attributeGet(attributes.ids.ATR_STRING);
    assert.strictEqual(res, mockResponse);
  });

  test("attributeSet", async () => {
    const payload = Uint8Array.of(0xf0, 0xba);

    const mockAttributeSet = mock.fn((id, value) => {
      assert.equal(id, attributes.ids.VENDOR_NAME);
      assert.strictEqual(value, payload);

      return Promise.resolve();
    });

    const mockCard = /** @type {pcsc.Card} */ ({
      attributeSet: /** @type {pcsc.Card["attributeSet"]}  */ (
        mockAttributeSet
      ),
    });

    const card = new Card(mockCard);
    await card.attributeSet(attributes.ids.VENDOR_NAME, payload);
    assert.equal(mockAttributeSet.mock.callCount(), 1);
  });

  test("control", async () => {
    const command = Uint8Array.of(0xf0, 0xba);
    const buf = new ArrayBuffer(MAX_BUFFER_LEN);

    const mockResponse = Uint8Array.of(0xca, 0xfe);
    const mockCard = /** @type {pcsc.Card} */ ({
      control(code, cmd, out) {
        assert.equal(code, 1996);
        assert.strictEqual(cmd, command);
        assert.strictEqual(out, buf);

        return Promise.resolve(mockResponse);
      },
    });

    const card = new Card(mockCard);
    const res = await card.control(1996, command, buf);
    assert.strictEqual(res, mockResponse);
  });

  test("control - optional params omitted", async () => {
    const mockResponse = Uint8Array.of(0xca, 0xfe);
    const mockCard = /** @type {pcsc.Card} */ ({
      control(code, cmd, out) {
        assert.equal(code, 1996);
        assert.equal(cmd, undefined);
        assert.equal(out, undefined);

        return Promise.resolve(mockResponse);
      },
    });

    const card = new Card(mockCard);
    const res = await card.control(1996);
    assert.strictEqual(res, mockResponse);
  });

  test("disconnect", async () => {
    const mockDisconnect = mock.fn(then => {
      assert.equal(then, CardDisposition.LEAVE);
      return Promise.resolve();
    });

    const mockCard = /** @type {pcsc.Card} */ ({
      disconnect: /** @type {pcsc.Card["disconnect"]}  */ (mockDisconnect),
    });

    const card = new Card(mockCard);
    await card.disconnect(CardDisposition.LEAVE);
    assert.equal(mockDisconnect.mock.callCount(), 1);
  });

  test("protocol()", async () => {
    const mockResponse = Protocol.T15;
    const mockCard = /** @type {pcsc.Card} */ ({
      protocol: () => mockResponse,
    });

    const card = new Card(mockCard);
    assert.equal(card.protocol(), mockResponse);
  });

  test("reconnect", async () => {
    const mockReconnect = mock.fn((mode, action) => {
      assert.equal(mode, CardMode.SHARED);
      assert.equal(action, CardDisposition.RESET);
      return Promise.resolve(Protocol.T15);
    });

    const mockCard = /** @type {pcsc.Card} */ ({
      reconnect: /** @type {pcsc.Card["reconnect"]} */ (mockReconnect),
    });

    const card = new Card(mockCard);
    const proto = await card.reconnect(CardMode.SHARED, CardDisposition.RESET);
    assert.equal(proto, Protocol.T15);
  });

  test("state()", async () => {
    /** @type  {pcsc.CardState} */
    const mockResponse = {
      atr: Uint8Array.of(0xca, 0xfe),
      protocol: Protocol.T0,
      readerName: "iReadCards",
      status: CardStatus.PRESENT,
    };

    const mockCard = /** @type {pcsc.Card} */ ({
      state: () => Promise.resolve(mockResponse),
    });

    const card = new Card(mockCard);
    const state = await card.state();
    assert.strictEqual(state.atr, mockResponse.atr);
    assert.strictEqual(state.protocol, mockResponse.protocol);
    assert.strictEqual(state.readerName, mockResponse.readerName);
    assert.strictEqual(state.status.raw, mockResponse.status);
  });

  test("transaction()", async () => {
    const mockTransaction = /** @type {pcsc.Transaction} */ ({});
    const mockCard = /** @type {pcsc.Card} */ ({
      transaction: () => Promise.resolve(mockTransaction),
    });

    const card = new Card(mockCard);
    assert.strictEqual(await card.transaction(), mockTransaction);
  });

  test("transmit", async () => {
    const payload = Uint8Array.of(0xf0, 0xba);
    const buf = new ArrayBuffer(MAX_BUFFER_LEN);

    const mockResponse = Uint8Array.of(0x90, 0x00);
    const mockCard = /** @type {pcsc.Card} */ ({
      transmit(protocol, input, output) {
        assert.strictEqual(protocol, undefined);
        assert.strictEqual(input, payload);
        assert.strictEqual(output, buf);

        return Promise.resolve(mockResponse);
      },
    });

    const card = new Card(mockCard);
    const res = await card.transmit(payload, buf);
    assert.strictEqual(res, mockResponse);
  });

  test("transmit - buffer omitted", async () => {
    const payload = Uint8Array.of(0xf0, 0xba);

    const mockResponse = Uint8Array.of(0x90, 0x00);
    const mockCard = /** @type {pcsc.Card} */ ({
      transmit(protocol, input, output) {
        assert.strictEqual(protocol, undefined);
        assert.strictEqual(input, payload);
        assert.strictEqual(output, undefined);

        return Promise.resolve(mockResponse);
      },
    });

    const card = new Card(mockCard);
    const res = await card.transmit(payload);
    assert.strictEqual(res, mockResponse);
  });

  test("transmitProtocol", async () => {
    const payload = Uint8Array.of(0xf0, 0xba);
    const buf = new ArrayBuffer(MAX_BUFFER_LEN);

    const mockResponse = Uint8Array.of(0x90, 0x00);
    const mockCard = /** @type {pcsc.Card} */ ({
      transmit(protocol, input, output) {
        assert.strictEqual(protocol, Protocol.T0);
        assert.strictEqual(input, payload);
        assert.strictEqual(output, buf);

        return Promise.resolve(mockResponse);
      },
    });

    const card = new Card(mockCard);
    const res = await card.transmitProtocol(Protocol.T0, payload, buf);
    assert.strictEqual(res, mockResponse);
  });

  test("transmitProtocol - buffer omitted", async () => {
    const payload = Uint8Array.of(0xf0, 0xba);

    const mockResponse = Uint8Array.of(0x90, 0x00);
    const mockCard = /** @type {pcsc.Card} */ ({
      transmit(protocol, input, output) {
        assert.strictEqual(protocol, Protocol.T1);
        assert.strictEqual(input, payload);
        assert.strictEqual(output, undefined);

        return Promise.resolve(mockResponse);
      },
    });

    const card = new Card(mockCard);
    const res = await card.transmitProtocol(Protocol.T1, payload);
    assert.strictEqual(res, mockResponse);
  });
});

describe("CardStatusFlags", () => {
  test("has()", () => {
    const none = new CardStatusFlags(0);
    assert.equal(none.has(CardStatus.ABSENT), false);

    const presentSpecific = new CardStatusFlags(
      CardStatus.PRESENT | CardStatus.SPECIFIC,
    );
    assert.equal(presentSpecific.has(CardStatus.SPECIFIC), true);
    assert.equal(presentSpecific.has(CardStatus.PRESENT), true);
    assert.equal(
      presentSpecific.has(CardStatus.PRESENT, CardStatus.SPECIFIC),
      true,
    );
    assert.equal(
      presentSpecific.has(CardStatus.PRESENT, CardStatus.ABSENT),
      false,
    );
  });

  test("hasAny()", () => {
    const none = new CardStatusFlags(0);
    assert.equal(none.hasAny(CardStatus.SPECIFIC), false);

    const presentSpecific = new CardStatusFlags(
      CardStatus.PRESENT | CardStatus.SPECIFIC,
    );
    assert.equal(presentSpecific.hasAny(CardStatus.SPECIFIC), true);
    assert.equal(presentSpecific.hasAny(CardStatus.PRESENT), true);
    assert.equal(
      presentSpecific.hasAny(CardStatus.PRESENT, CardStatus.SPECIFIC),
      true,
    );
    assert.equal(
      presentSpecific.hasAny(CardStatus.PRESENT, CardStatus.ABSENT),
      true,
    );
  });

  test("toString()", () => {
    const none = new CardStatusFlags(0);
    assert.equal(none.toString(), "{ }");

    const present = new CardStatusFlags(CardStatus.PRESENT);
    assert.equal(present.toString(), "{ PRESENT }");

    const presentSpecific = new CardStatusFlags(
      CardStatus.PRESENT | CardStatus.SPECIFIC,
    );
    assert.equal(presentSpecific.toString(), "{ PRESENT | SPECIFIC }");
  });
});
