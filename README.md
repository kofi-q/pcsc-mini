# pcsc-mini • <a href="https://npmjs.com/package/pcsc-mini"><img alt="NPM Version" height="21px" src="https://img.shields.io/npm/v/pcsc-mini?style=for-the-badge&logo=npm&logoColor=%23333&logoSize=auto&labelColor=%23eee&color=%23a85270"></a>

` › NodeJS PC/SC API bindings for smart card access on Linux / MacOS / Win32 `

[Docs ↗](https://kofi-q.github.io/pcsc-mini) | | [Overview](#overview) | | [Prerequisites](#prerequisites) | | [Installation](#installation) | | [Usage](#usage)

```ts
import * as pcsc from "pcsc-mini";
const { CardDisposition, CardMode, ReaderStatus } = pcsc;

const client = new pcsc.Client()
  .on("reader", onReader)
  .start();

function onReader(reader: pcsc.Reader) {
  reader.on("change", async status => {
    if (!status.has(ReaderStatus.PRESENT)) return;
    if (status.hasAny(ReaderStatus.MUTE, ReaderStatus.IN_USE)) return;

    const card = await reader.connect(CardMode.SHARED);
    console.log(`${await card.state()}`);

    const resTx =  await card.transmit(
      Uint8Array.of(0xca, 0xfe, 0xf0, 0x0d)
    );
    console.log(resTx);

    const codeFeatures = pcsc.controlCode(3400);
    const features = await card.control(codeFeatures);
    console.log(features);

    await card.disconnect(CardDisposition.RESET);
    client.stop();
    process.exit(0);
  });
}
```

## Overview

`pcsc-mini` provides NodeJS bindings to native PC/SC (Personal Computer/Smart Card) APIs:
- [`pcsc-lite`](https://pcsclite.apdu.fr/api/winscard_8h.html) on Linux and MacOS<sup>*</sup>
- [`winscard`](https://learn.microsoft.com/en-us/windows/win32/api/winscard/) on Windows.

<sup>* MacOS has a separate implementation built on the [`CryptoTokenKit`](https://developer.apple.com/documentation/cryptotokenkit?language=objc) API.</sup>

### Supported Platforms

Pre-built binary packages are available for the following targets.

 These are installed as optional dependencies of the main `pcsc-mini` package (e.g. `@pcsc-mini/linux-x86_64-gnu`).

| OS                           | arm64 |  x86  | x86_64 |
|------------------------------|:-----:|:-----:|:------:|
| `Linux ( gnu )`              |   ✅  |  ☑️   |   ✅   |
| `Linux ( musl )`<sup>*</sup> |   ✅  |  ☑️   |   ✅   |
| `MacOS`                      |   ✅  | `N/A` |   ☑️   |
| `Windows`                    |   ☑️  |  ⬜️   |   ✅   |

<sub>✅ Tested & verified&nbsp;&nbsp;•&nbsp;</sub>
<sub>☑️ Not tested&nbsp;&nbsp;•&nbsp;</sub>
<sub>⬜️ Not available</sub>

<sub>* During testing on Alpine, the PCSC server daemon needed to be started *after* a reader was connected for detection/monitoring to work and required a restart whenever a reader was disconnected and reconnected.</sub>

### JS Runtime Compatibility

| Runtime                | Supported Versions                            |
|------------------------|-----------------------------------------------|
| **NodeJS**             | `v16.x.x, v18.x.x, v20.x.x, v22.x.x v24.x.x`  |
| **<sub>OTHERS:</sub>** |                                               |
| **Bun**                | `Tested with v1.2.12 (may work with earlier)` |
| **Deno**               | `Tested with v2.3.1 (may work with earlier)`  |
| **Electron**           | `v15.0.0+ (Tested up to v36.2.0)`             |

## Prerequisites

### Linux - Alpine

Required packages:

- `ccid`
- `pcsc-lite`
- `pcsc-lite-libs`

```sh
doas apk add ccid pcsc-lite pcsc-lite-libs
```
To run the server daemon:
```sh
doas rc-service pcscd start
```

### Linux - Debian/Ubuntu/etc

Required packages:

- `libpcsclite1`
- `pcscd`

```sh
sudo apt install libpcsclite1 pcscd
```
To run the server daemon:
```sh
sudo systemctl start pcscd
```

### MacOS/Windows

**`N/A` ::**  MacOS and Windows come pre-installed with smart card support. No additional installation needed.

<br />

## Installation

**Bun**
```sh
bun add pcsc-mini
```

**Deno**
```sh
deno add npm:pcsc-mini
```

**npm**
```sh
npm i pcsc-mini
```

**pnpm**
```sh
pnpm add pcsc-mini
```

## Usage

```ts
import * as pcsc from "pcsc-mini";
const { CardDisposition, CardMode, ReaderStatus } = pcsc;

// The `Client` emits a "reader" event for each detected device.
const client = new pcsc.Client()
  .on("reader", onReader)
  .on("error", onError)
  .start();

function onError(err: pcsc.Err) {
  console.error("Unexpected PCSC error:", err);
  client.stop();

  // [ Log and exit / attempt `start()` retries with backoff / etc... ]
};

function onReader(reader: pcsc.Reader) {
  let card: pcsc.Card | undefined;

  console.log(`Reader detected: ${reader}`);

  // Each reader emits a "change" event on every reader state change.
  reader.on("change", async status => {
    if (status.hasAny(ReaderStatus.MUTE, ReaderStatus.IN_USE)) return;

    if (!status.has(ReaderStatus.PRESENT)) {
      void card?.disconnect(CardDisposition.RESET);
      card = undefined;
      return;
    }

    try {
      if (!card) card = await reader.connect(CardMode.SHARED);

      // Transmit Uint8Array (or NodeJS Buffer) data:
      const res = await card.transmit(
        Uint8Array.of(0xca, 0xfe, 0xf0, 0x0d)
      );

      // Use Uint8Array response directly, or via DataView/Buffer:
      const vw = new DataView(res.buffer, res.byteOffset, res.length);
      const tag = vw.getUint8(0);
      const len = vw.getUint16(2);
      const val = new Uint8Array(res.buffer, 4, len);

      // ...
    } catch (err) {
      console.error("Card error:", err);
    }
  });

  // "disconnect" is emitted when a reader is no longer detected.
  //
  // All event listeners will be removed from the now-invalid reader.
  // Any reader/card-related state should be disposed of here.
  reader.on("disconnect", async () => {
    void card?.disconnect(CardDisposition.RESET);
    card = undefined;
  });
}
```

> [!TIP]
>
> See the [E2E test application](./e2e/index.js) for more involved usage and error handling.

## Development

### Prerequisites

|                          | Minimum Version | Recommended Version                |
|--------------------------|-----------------|------------------------------------|
| **Zig**                  | v0.14.1         | See [`.zigversion`](.zigversion)   |
| **NodeJS**               | v24.0.0         | See [`.nvmrc`](.nvmrc)             |
| **pnpm**                 | v10.0.0         | See [`package.json`](package.json) |
| **<sub>OPTIONAL:</sub>** |                 |                                    |
| **Bun**                  | v1.2.12         |                                    |
| **Deno**                 | v2.3.1          |                                    |


#### Linux

See [Prerequisites](#prerequisites) section above for a list of runtime prerequisites.

Other relevant development libraries (e.g. `libpcsclite-dev` on Debian-based distros) are included in the [`pcsc`](https://github.com/kofi-q/pcsc-z) dependency. No additional installation needed.

#### MacOS

**`N/A` ::** Required MacOS Framework `.tbd`s are included in the [`pcsc`](https://github.com/kofi-q/pcsc-z) dependency. No additional installation needed.

#### Windows

**`N/A` ::** Required DLLs are shipped with the Zig compiler. No additional installation needed.

### Building & Testing

#### Building the dev addon binary:

This will output an `lib/addon.node` file to enable unit testing. Runs automatically when running the unit tests.

```sh
zig build
```

#### Running Zig and NodeJS unit tests:

```sh
zig build test
```

##### Or individually:

```sh
zig build test:node -- --watch
```
```sh
zig build test:zig --watch
```

#### Running the E2E test application:

This enables testing basic operations against real devices (supporting up to 4 simultaneously connected readers) to verify functionality not testable via unit tests.

```sh
zig build e2e
```

#### Generating the NPM packages:

This will output the final NPM package directories to `./zig-out/npm_packages`.

```sh
zig build packages
```

## License

[MIT](./LICENSE)
