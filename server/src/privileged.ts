import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

export const privileged = definePrivilegedContracts({
  terminalSession: {
    request: z.object({
      operation: z.enum(["start", "read", "write", "resize", "restart", "kill"]),
      sessionId: z.string().regex(/^[a-z0-9-]{8,64}$/),
      data: z.string().max(65536).optional(),
      offset: z.number().int().nonnegative().max(1_000_000_000).default(0),
      cols: z.number().int().min(20).max(240).default(80),
      rows: z.number().int().min(6).max(120).default(24),
    }),
    response: z.object({
      ok: z.boolean(),
      alive: z.boolean(),
      dataBase64: z.string(),
      nextOffset: z.number().int().nonnegative(),
      truncated: z.boolean(),
      command: z.string(),
      error: z.string().optional(),
    }),
    capabilities: ["shell.execute"],
    timeoutMs: 10_000,
  },
});

const TMUX = "/usr/bin/tmux";
const SOCKET = "muse-web-terminal";
const STATE_DIR = "/tmp/muse-web-terminal";
const MAX_READ_BYTES = 256 * 1024;
function shellCommand(id: string): string {
  return "/usr/bin/env HOME=/home/hatch " +
  "PATH=/home/hatch/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin " +
  "TERM=xterm-256color COLORTERM=truecolor LANG=C.UTF-8 LC_ALL=C.UTF-8 " +
  `/usr/bin/bash --noprofile --rcfile '${STATE_DIR}/${id}.rc' -i`;
}

// Restore the installed cell network settings, retaining the executor's
// Space-scoped proxy context. Never copy unrelated secrets into the shell.
const NETWORK_ENV_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "AWS_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "GIT_SSL_CAINFO", "WGETRC",
  "JARVIS_RUNTIME_CONTEXT_TOKEN",
] as const;

function updateNetworkEnvironment(id: string): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const defaults: Record<string, string> = {};
  for (const line of readFileSync("/etc/environment", "utf8").split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) defaults[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const exports = NETWORK_ENV_KEYS.flatMap(key => {
    const value = process.env[key] ?? defaults[key];
    return value === undefined ? [] : [`export ${key}=${quote(value)}`];
  }).join("\n") + "\n";
  const temporary = `${STATE_DIR}/${id}.env-${process.pid}`;
  writeFileSync(temporary, exports, { mode: 0o600 });
  renameSync(temporary, `${STATE_DIR}/${id}.env`);
  // A privileged action's proxy context expires. Refresh before input delivery
  // and source it before each shell command, including after a long idle.
  if (!existsSync(`${STATE_DIR}/${id}.rc`)) {
    writeFileSync(`${STATE_DIR}/${id}.rc`,
      "PS1='\\[\\e]133;A\\a\\]\\[\\e[38;5;114m\\]\\w\\[\\e[0m\\] ❯ \\[\\e]133;B\\a\\]'\n" +
      "PS2='\\[\\e]133;A\\a\\]> \\[\\e]133;B\\a\\]'\n" +
      "PS0='\\e]133;C\\a'\n" +
      `. '${STATE_DIR}/${id}.env'\ntrap ". '${STATE_DIR}/${id}.env'" DEBUG\n`,
      { mode: 0o600 });
  }
}

function tmux(args: string[], input?: Uint8Array) {
  return Bun.spawnSync([TMUX, "-L", SOCKET, ...args], {
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      HOME: "/home/hatch",
      PATH: "/home/hatch/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      TERM: "xterm-256color",
    },
  });
}

function outputText(value: Uint8Array | null | undefined): string {
  return value ? new TextDecoder().decode(value).trim() : "";
}

function sessionName(id: string): string {
  return `web-${id}`;
}

function logPath(id: string): string {
  return `${STATE_DIR}/${id}.log`;
}

function isAlive(name: string): boolean {
  return tmux(["has-session", "-t", name]).exitCode === 0;
}

function resize(name: string, cols: number, rows: number): void {
  tmux(["resize-window", "-t", name, "-x", String(cols), "-y", String(rows)]);
}

function attachPipe(name: string, path: string): void {
  tmux(["pipe-pane", "-t", `${name}:0.0`, "-o", `cat >> '${path}'`]);
}

function ensureSession(id: string, cols: number, rows: number): { name: string; path: string } {
  mkdirSync(STATE_DIR, { recursive: true });
  const name = sessionName(id);
  const path = logPath(id);

  if (!isAlive(name)) {
    writeFileSync(path, new Uint8Array());
    const created = tmux([
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      String(cols),
      "-y",
      String(rows),
      shellCommand(id),
    ]);
    if (created.exitCode !== 0) {
      throw new Error(outputText(created.stderr) || "Could not start the shell session.");
    }
    attachPipe(name, path);
    tmux(["send-keys", "-t", `${name}:0.0`, "C-l"]);
  } else {
    if (!existsSync(path)) {
      writeFileSync(path, new Uint8Array());
      attachPipe(name, path);
      tmux(["send-keys", "-t", `${name}:0.0`, "C-l"]);
    }
  }

  return { name, path };
}

function readChunk(path: string, requestedOffset: number) {
  if (!existsSync(path)) {
    return { dataBase64: "", nextOffset: 0, truncated: false };
  }

  const size = statSync(path).size;
  let offset = Math.min(requestedOffset, size);
  let truncated = requestedOffset > size;
  if (size - offset > MAX_READ_BYTES) {
    offset = size - MAX_READ_BYTES;
    truncated = true;
  }

  const length = Math.min(size - offset, MAX_READ_BYTES);
  if (length <= 0) {
    return { dataBase64: "", nextOffset: size, truncated };
  }

  const bytes = Buffer.allocUnsafe(length);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, bytes, 0, length, offset);
    return {
      dataBase64: bytes.subarray(0, read).toString("base64"),
      nextOffset: offset + read,
      truncated,
    };
  } finally {
    closeSync(fd);
  }
}

function currentCommand(name: string): string {
  const result = tmux([
    "display-message",
    "-p",
    "-t",
    `${name}:0.0`,
    "#{pane_current_command}",
  ]);
  if (result.exitCode !== 0) throw new Error("Shell session ended. Reconnecting.");
  return outputText(result.stdout) || "shell";
}

function stopSession(id: string): void {
  const name = sessionName(id);
  if (isAlive(name)) {
    tmux(["kill-session", "-t", name]);
  }
  const path = logPath(id);
  if (existsSync(path)) unlinkSync(path);
  for (const suffix of ["env", "rc"]) {
    const file = `${STATE_DIR}/${id}.${suffix}`;
    if (existsSync(file)) unlinkSync(file);
  }
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async terminalSession(args) {
    try {
      if (args.operation === "kill") {
        stopSession(args.sessionId);
        return {
          ok: true,
          alive: false,
          dataBase64: "",
          nextOffset: 0,
          truncated: false,
          command: "shell",
        };
      }

      if (args.operation === "restart") {
        stopSession(args.sessionId);
      }

      if (args.operation === "start" || args.operation === "restart" || args.operation === "write") {
        updateNetworkEnvironment(args.sessionId);
      }

      const { name, path } = args.operation === "start" || args.operation === "restart"
        ? ensureSession(args.sessionId, args.cols, args.rows)
        : { name: sessionName(args.sessionId), path: logPath(args.sessionId) };

      if (args.operation === "write" && args.data) {
        // Hex bytes preserve Enter, arrows, backspace, and Ctrl-C as PTY
        // input, rather than converting every keyboard event into a paste.
        const bytes = Buffer.from(args.data, "utf8");
        for (let offset = 0; offset < bytes.length; offset += 2048) {
          const sent = tmux(["send-keys", "-t", `${name}:0.0`, "-H",
            ...Array.from(bytes.subarray(offset, offset + 2048), b => b.toString(16))]);
          if (sent.exitCode !== 0) throw new Error(outputText(sent.stderr) || "Could not send input.");
        }
        // Let the PTY echo reach its capture pipe in this same response.
        const deadline = Date.now() + 60;
        while (existsSync(path) && statSync(path).size <= args.offset && Date.now() < deadline) {
          await Bun.sleep(3);
        }
      }

      if (args.operation === "resize" || args.operation === "start") {
        resize(name, args.cols, args.rows);
      }

      const chunk = readChunk(path, args.offset);
      return {
        ok: true,
        alive: true,
        ...chunk,
        command: currentCommand(name),
      };
    } catch (error) {
      return {
        ok: false,
        alive: false,
        dataBase64: "",
        nextOffset: args.offset,
        truncated: false,
        command: "shell",
        error: error instanceof Error ? error.message : "Terminal backend failed.",
      };
    }
  },
});
