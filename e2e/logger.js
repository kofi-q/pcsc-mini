const util = require("node:util");

/** @import chalk from "chalk" */

class Logger {
  /** @type {chalk} */
  #chalk;

  /** @type {any[]} */
  #buf = [];
  #idx = 0;

  /** @param {chalk} chalk */
  constructor(chalk) {
    this.#chalk = chalk;
  }

  flush() {
    if (this.#idx === 0) return;

    this.#buf.length = this.#idx;
    console.log(...this.#buf);

    this.#buf = new Array(10);
    this.#idx = 0;
  }

  /** @param {any[]} chunks */
  log(...chunks) {
    for (let i = 0; i < chunks.length; i += 1, this.#idx += 1) {
      if (typeof chunks[i] !== "string") {
        this.#buf[this.#idx] = this.#chalk(util.inspect(chunks[i], {}));
        continue;
      }

      this.#buf[this.#idx] = this.#chalk(chunks[i]);
    }
  }

  /**  @param {any[]} chunks */
  logNow(...chunks) {
    this.log(...chunks);
    this.flush();
  }
}

module.exports = { Logger };
