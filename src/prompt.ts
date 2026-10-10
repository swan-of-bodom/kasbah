import { emitKeypressEvents } from "node:readline";
import { fit } from "./dashboard.ts";

type Key = { name?: string; ctrl?: boolean };
export type Option<T> = { label: string; value: T; hint?: string };

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** Questions in the terminal: typed answers, a list to pick from or tick, yes/no, and steps with a spinner. */
export class Prompt {
  readonly #in: NodeJS.ReadStream;
  readonly #out: NodeJS.WriteStream;
  readonly #color: boolean;

  constructor(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout) {
    this.#in = input;
    this.#out = output;
    this.#color = output.isTTY === true && process.env.NO_COLOR === undefined;
  }

  #c = (code: number, close: number) => (s: string) => (this.#color ? `\x1b[${code}m${s}\x1b[${close}m` : s);
  readonly dim = this.#c(2, 22);
  readonly bold = this.#c(1, 22);
  readonly cyan = this.#c(36, 39);
  readonly green = this.#c(32, 39);
  readonly red = this.#c(31, 39);
  readonly yellow = this.#c(33, 39);

  line(text = "") {
    this.#out.write(`${text}\n`);
  }

  /** Redraws `frame` after every key until `onKey` returns a value; the last frame (`done`) stays. */
  #ask<T>(frame: (done: boolean, error?: string) => string[], onKey: (key: Key, char: string | undefined) => T | { error: string } | undefined): Promise<T> {
    emitKeypressEvents(this.#in);
    this.#in.setRawMode(true);
    this.#in.resume();
    this.#out.write("\x1b[?25l");
    let drawn = 0;
    const width = this.#out.columns || 100;
    const draw = (done: boolean, error?: string) => {
      // One terminal row per line: a longer line would wrap and the next redraw would miss it.
      const lines = frame(done, error).map((l) => fit(l, width - 1));
      this.#out.write(`${drawn > 0 ? `\x1b[${drawn}F\x1b[J` : ""}${lines.join("\n")}\n`);
      drawn = lines.length;
    };
    draw(false);
    return new Promise((resolve) => {
      const done = () => {
        this.#in.off("keypress", onPress);
        this.#in.setRawMode(false);
        this.#in.pause();
        this.#out.write("\x1b[?25h");
      };
      const onPress = (char: string | undefined, key: Key | undefined) => {
        if (key?.ctrl && key.name === "c") {
          done();
          this.#out.write("\n");
          process.exit(130);
        }
        const answer = onKey(key ?? {}, char);
        if (answer === undefined) return draw(false);
        if (typeof answer === "object" && answer !== null && "error" in answer) return draw(false, answer.error);
        draw(true);
        done();
        resolve(answer as T);
      };
      this.#in.on("keypress", onPress);
    });
  }

  #title(done: boolean, label: string) {
    return `${done ? this.green("✓") : this.cyan("?")} ${this.bold(label)}`;
  }

  /** A typed answer; `check` returns an error to show, or nothing. Enter on an empty line takes `initial`. */
  text(label: string, o: { initial?: string; hint?: string; check?: (v: string) => string | undefined } = {}): Promise<string> {
    let value = "";
    return this.#ask(
      (done, error) => {
        const shown = value === "" && o.initial !== undefined ? this.dim(o.initial) : value;
        const lines = [`${this.#title(done, label)}  ${done ? this.cyan(value || o.initial || "") : `${shown}${this.cyan("▏")}`}`];
        if (!done && o.hint !== undefined) lines.push(this.dim(`  ${o.hint}`));
        if (!done && error !== undefined) lines.push(this.red(`  ${error}`));
        return lines;
      },
      (key, char) => {
        if (key.name === "return") {
          const v = value.trim() || o.initial || "";
          const error = o.check?.(v);
          if (error !== undefined) return { error };
          value = v;
          return v;
        }
        if (key.name === "backspace") value = value.slice(0, -1);
        else if (char !== undefined && !key.ctrl && char >= " ") value += char;
        return undefined;
      },
    );
  }

  /** One of `options`, with the arrow keys. */
  select<T>(label: string, options: Option<T>[], initial = 0): Promise<T> {
    let at = initial;
    return this.#ask(
      (done) =>
        done
          ? [`${this.#title(true, label)}  ${this.cyan(options[at]!.label)}`]
          : [this.#title(false, label), ...options.map((o, i) => `  ${i === at ? this.cyan(`❯ ${o.label}`) : `  ${o.label}`}${o.hint === undefined ? "" : this.dim(`  ${o.hint}`)}`)],
      (key) => {
        if (key.name === "up") at = (at + options.length - 1) % options.length;
        else if (key.name === "down") at = (at + 1) % options.length;
        else if (key.name === "return") return options[at]!.value;
        return undefined;
      },
    );
  }

  /** Any of `options`: space ticks one, `a` all or none, enter takes at least one. A long list scrolls. */
  multi<T>(label: string, options: Option<T>[], ticked: boolean[] = options.map(() => true)): Promise<T[]> {
    let at = 0;
    const on = [...ticked];
    const rows = Math.max(5, Math.min(options.length, (this.#out.rows || 24) - 6));
    return this.#ask(
      (done, error) => {
        if (done) return [`${this.#title(true, label)}  ${this.cyan(options.filter((_, i) => on[i]).map((o) => o.label).join(", "))}`];
        const top = Math.min(Math.max(0, at - Math.floor(rows / 2)), options.length - rows);
        const lines = [`${this.#title(false, label)}  ${this.dim("space: tick · a: all · enter: done")}`];
        for (let i = Math.max(0, top); i < Math.min(options.length, Math.max(0, top) + rows); i++) {
          const o = options[i]!;
          const box = on[i] ? this.green("◼") : this.dim("◻");
          lines.push(`  ${i === at ? this.cyan("❯") : " "} ${box} ${i === at ? this.cyan(o.label) : o.label}${o.hint === undefined ? "" : this.dim(`  ${o.hint}`)}`);
        }
        if (options.length > rows) lines.push(this.dim(`  ${on.filter(Boolean).length} of ${options.length} ticked`));
        if (error !== undefined) lines.push(this.red(`  ${error}`));
        return lines;
      },
      (key, char) => {
        if (key.name === "up") at = (at + options.length - 1) % options.length;
        else if (key.name === "down") at = (at + 1) % options.length;
        else if (key.name === "space") on[at] = !on[at];
        else if (char === "a") on.fill(!on.every(Boolean));
        else if (key.name === "return") return on.some(Boolean) ? options.filter((_, i) => on[i]).map((o) => o.value) : { error: "tick at least one" };
        return undefined;
      },
    );
  }

  confirm(label: string, initial = true): Promise<boolean> {
    let answer: boolean | undefined;
    return this.#ask(
      (done) => [`${this.#title(done, label)}  ${done ? this.cyan(answer ? "yes" : "no") : this.dim(initial ? "Y/n" : "y/N")}`],
      (key, char) => {
        if (key.name === "return") answer = initial;
        else if (char === "y" || char === "Y") answer = true;
        else if (char === "n" || char === "N") answer = false;
        return answer;
      },
    );
  }

  /** `work` under a spinner, then ✓ with `result`'s line, or ✗ with the error (rethrown). */
  async step<T>(label: string, work: () => Promise<T>, result: (v: T) => string): Promise<T> {
    const tty = this.#out.isTTY === true;
    let i = 0;
    const timer = tty ? setInterval(() => this.#out.write(`\r${this.cyan(SPINNER[i++ % SPINNER.length]!)} ${label}`), 80) : undefined;
    try {
      const v = await work();
      this.#out.write(`${tty ? "\r\x1b[K" : ""}${this.green("✓")} ${label}  ${this.dim(result(v))}\n`);
      return v;
    } catch (e) {
      this.#out.write(`${tty ? "\r\x1b[K" : ""}${this.red("✗")} ${label}  ${this.red((e as Error).message)}\n`);
      throw e;
    } finally {
      clearInterval(timer);
    }
  }
}
