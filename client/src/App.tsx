import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api, type ApiResponse } from "./api";

type TerminalResponse = ApiResponse<typeof api, "terminal">;
type ConnectionState = "connecting" | "connected" | "offline";
type TerminalOperation = "start" | "read" | "write" | "resize" | "restart" | "kill";

const SESSION_STORAGE_KEY = "muse-terminal-session-v5";
let inMemorySessionId = "";

function createSessionId(): string {
  try {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replaceAll("-", "").slice(0, 24);
    }
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.slice(0, 24);
  }
}

function getSessionId(): string {
  // Desktop browsers can deny storage access to a sandboxed, cross-origin
  // iframe. Storage is only an optimization for restoring the same shell; it
  // must never prevent the terminal itself from starting.
  try {
    const existing = localStorage.getItem(SESSION_STORAGE_KEY);
    if (existing && /^[a-z0-9-]{8,64}$/.test(existing)) return existing;
  } catch {
    // Fall back to a stable ID for this page load below.
  }

  if (!inMemorySessionId) inMemorySessionId = createSessionId();
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, inMemorySessionId);
  } catch {
    // Some desktop hosts intentionally expose no persistent iframe storage.
  }
  return inMemorySessionId;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function App() {
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef("");
  const offsetRef = useRef(0);
  const decoderRef = useRef(new TextDecoder());
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [command, setCommand] = useState("shell");
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(0);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let active = true;
    sessionIdRef.current = getSessionId();

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      disableStdin: false,
      drawBoldTextInBrightColors: false,
      fontFamily: '"Berkeley Mono", "SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: window.innerWidth < 560 ? 13 : 14,
      fontWeight: "400",
      fontWeightBold: "600",
      letterSpacing: 0,
      lineHeight: 1.25,
      minimumContrastRatio: 7,
      scrollback: 5000,
      theme: {
        background: "#090b0c",
        foreground: "#dce5e1",
        cursor: "#7ce3a1",
        cursorAccent: "#090b0c",
        selectionBackground: "#345544",
        black: "#171b1d",
        red: "#f27d7d",
        green: "#7ce3a1",
        yellow: "#f6c85f",
        blue: "#79a8f8",
        magenta: "#d59bf6",
        cyan: "#78dce8",
        white: "#dce5e1",
        brightBlack: "#59615e",
        brightRed: "#ff9b9b",
        brightGreen: "#a2efbc",
        brightYellow: "#ffdc82",
        brightBlue: "#9bc0ff",
        brightMagenta: "#e5b5ff",
        brightCyan: "#a4edf4",
        brightWhite: "#f7fbf9",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(mount);
    const fitTerminal = () => {
      const proposed = fit.proposeDimensions();
      if (proposed) terminal.resize(Math.max(20, Math.min(240, proposed.cols)),
        Math.max(6, Math.min(120, proposed.rows)));
    };
    fitTerminal();
    terminalRef.current = terminal;
    fitRef.current = fit;

    // xterm does not claim focus when it is opened. In an iframe this means the
    // caret can look absent and taps may leave focus on the host shell instead
    // of the hidden textarea that receives keyboard input. Desktop can focus
    // immediately; touch devices focus synchronously from the pointer gesture
    // below so the software keyboard is allowed to open.
    if (window.matchMedia("(pointer: fine)").matches) {
      window.requestAnimationFrame(() => terminal.focus());
    }
    // A native editor sits at the actual prompt. It only activates on the
    // shell's explicit prompt marker; foreground programs always use raw PTY.
    const editor = document.createElement("input");
    editor.className = "inline-terminal-editor";
    editor.setAttribute("aria-label", "Shell prompt");
    editor.autocomplete = "off";
    editor.autocapitalize = "off";
    editor.spellcheck = false;
    editor.hidden = true;
    mount.appendChild(editor);
    let atPrompt = false;
    let promptPending = false;
    let redrawDraft = "";
    let submissionPending = false;
    let submissionEchoed = false;
    const positionEditor = () => {
      if (!atPrompt) return;
      const screen = mount.querySelector<HTMLElement>(".xterm-screen");
      if (!screen) return;
      const bounds = screen.getBoundingClientRect();
      const parent = mount.getBoundingClientRect();
      const buffer = terminal.buffer.active;
      const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
      editor.hidden = row < 0 || row >= terminal.rows;
      const cellWidth = bounds.width / terminal.cols;
      const cellHeight = bounds.height / terminal.rows;
      Object.assign(editor.style, {
        left: `${bounds.left - parent.left + buffer.cursorX * cellWidth}px`,
        top: `${bounds.top - parent.top + row * cellHeight}px`,
        width: `${Math.max(cellWidth, bounds.width - buffer.cursorX * cellWidth)}px`,
        height: `${cellHeight}px`, fontSize: `${terminal.options.fontSize}px`,
        fontFamily: terminal.options.fontFamily,
      });
    };
    const leavePrompt = () => {
      atPrompt = false;
      promptPending = false;
      if (!submissionPending) {
        editor.hidden = true;
        editor.value = "";
        editor.readOnly = false;
      }
      terminal.options.cursorBlink = true;
      terminal.options.cursorStyle = "bar";
    };
    const promptMarker = terminal.parser.registerOscHandler(133, (value) => {
      if (value === "A") {
        redrawDraft = atPrompt ? editor.value : "";
        submissionEchoed = submissionPending;
        leavePrompt();
      }
      if (value === "C") { redrawDraft = ""; submissionEchoed = submissionPending; leavePrompt(); }
      if (value === "B") promptPending = true;
      return true;
    });
    const parsed = terminal.onWriteParsed(() => {
      if (promptPending && (!submissionPending || submissionEchoed)) {
        submissionPending = false;
        submissionEchoed = false;
        editor.readOnly = false;
        promptPending = false;
        atPrompt = true;
        editor.value = redrawDraft;
        redrawDraft = "";
        historyIndexRef.current = historyRef.current.length;
        positionEditor();
        editor.focus();
      }
      positionEditor();
    });
    const scrolled = terminal.onScroll(positionEditor);
    const rendered = terminal.onRender(() => {
      // Keep the submitted line visible until xterm paints its PTY echo.
      if (submissionPending && submissionEchoed) {
        submissionPending = false;
        submissionEchoed = false;
        leavePrompt();
      }
      positionEditor();
    });
    const focusTerminal = () => { if (atPrompt) editor.focus(); else terminal.focus(); };
    mount.addEventListener("pointerdown", focusTerminal, { capture: true });
    mount.addEventListener("click", focusTerminal);

    const consume = (result: TerminalResponse) => {
      if (!active) return;
      if (!result.ok) {
        setConnection("offline");
        return;
      }
      setConnection(result.alive ? "connected" : "offline");
      setCommand(result.command || "shell");
      // Reads and writes can overlap. Absolute byte offsets let either
      // response advance the screen while discarding already-rendered bytes.
      const bytes = decodeBase64(result.dataBase64);
      const start = result.nextOffset - bytes.length;
      if (result.nextOffset <= offsetRef.current) return;
      if (start > offsetRef.current) {
        decoderRef.current = new TextDecoder();
        terminal.writeln("\r\n[older terminal output was trimmed]\r\n");
      }
      const fresh = bytes.subarray(Math.max(0, offsetRef.current - start));
      if (fresh.length) terminal.write(decoderRef.current.decode(fresh, { stream: true }));
      offsetRef.current = result.nextOffset;
    };

    // One writer coalesces input; one reader polls independently. Neither
    // can accumulate a queue of requests behind a slow response.

    let pendingInput = "";
    let starting = true;
    let restarting = false;
    let sizeDirty = false;
    let busy = false;
    let writeBusy = false;
    let writeTimer: number | null = null;
    let timer: number | null = null;
    let lastCols = terminal.cols;
    let lastRows = terminal.rows;

    const schedule = (delay = 0) => {
      if (!active || busy) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(pump, delay);
    };
    const pump = async () => {
      timer = null;
      if (!active || busy) return;
      if ((restarting || starting) && writeBusy) { schedule(10); return; }
      busy = true;
      const operation: TerminalOperation = restarting ? "restart" : starting ? "start"
        : sizeDirty ? "resize" : "read";
      if (operation === "restart") {
        restarting = false;
        starting = true;
        offsetRef.current = 0;
        decoderRef.current = new TextDecoder();
        terminal.reset();
      }
      const cols = Math.max(20, Math.min(240, terminal.cols));
      const rows = Math.max(6, Math.min(120, terminal.rows));
      if (operation === "resize" || operation === "start" || operation === "restart") {
        sizeDirty = false;
        lastCols = terminal.cols;
        lastRows = terminal.rows;
      }
      let failed = false;
      try {
        const result = await api.terminal({ operation, sessionId: sessionIdRef.current,
          offset: offsetRef.current, cols, rows });
        if (!active) return;
        if (operation === "start" && result.ok && result.nextOffset < offsetRef.current) {
          offsetRef.current = 0;
          decoderRef.current = new TextDecoder();
        }
        consume(result);
        starting = !result.ok;
        failed = !result.ok;
      } catch {
        if (!active) return;
        starting = true;
        failed = true;
        setConnection("offline");
      } finally {
        busy = false;
        if (active) {
          schedule(failed ? 1000 : restarting || sizeDirty ? 0 : document.hidden ? 1000 : 60);
          if (!failed) scheduleWrite();
        }
      }
    };
    const scheduleWrite = () => {
      if (!active || starting || restarting || writeBusy || !pendingInput || writeTimer !== null) return;
      writeTimer = window.setTimeout(writeInput, 0);
    };
    const writeInput = async () => {
      writeTimer = null;
      if (!active || starting || restarting || writeBusy || !pendingInput) return;
      writeBusy = true;
      let count = Math.min(4096, pendingInput.length);
      if (count < pendingInput.length && /[\uD800-\uDBFF]/.test(pendingInput.charAt(count - 1))) count--;
      const data = pendingInput.slice(0, count);
      pendingInput = pendingInput.slice(count);
      try {
        const result = await api.terminal({ operation: "write", sessionId: sessionIdRef.current,
          offset: offsetRef.current, cols: Math.max(20, Math.min(240, terminal.cols)),
          rows: Math.max(6, Math.min(120, terminal.rows)), data });
        if (!active) return;
        if (!result.ok) throw new Error(result.error);
        consume(result);
      } catch {
        if (!active) return;
        pendingInput = "";
        starting = true;
        setConnection("offline");
        submissionPending = false;
        submissionEchoed = false;
        leavePrompt();
        terminal.writeln("\r\n[Input delivery uncertain; input was not replayed.]\r\n");
      } finally {
        writeBusy = false;
        scheduleWrite();
      }
    };
    const queueInput = (data: string) => {
      if (pendingInput.length + data.length > 1024 * 1024) {
        terminal.write("\x07");
        return;
      }
      pendingInput += data;
      scheduleWrite();
    };
    const sendEditor = (suffix: string) => {
      const value = editor.value;
      if (suffix === "\r") {
        submissionPending = true;
        submissionEchoed = false;
        editor.readOnly = true;
      }
      leavePrompt();
      terminal.focus();
      // The shell supplies the authoritative echo once, after submission.
      queueInput(value + suffix);
    };
    editor.addEventListener("paste", (event) => {
      const pasted = event.clipboardData?.getData("text/plain");
      if (!atPrompt || !pasted || !/[\r\n]/.test(pasted)) return;
      event.preventDefault();
      const value = editor.value.slice(0, editor.selectionStart ?? editor.value.length)
        + pasted + editor.value.slice(editor.selectionEnd ?? editor.value.length);
      leavePrompt();
      terminal.focus();
      // A single-line HTML input would silently strip newlines. Let Bash's
      // bracketed-paste editor retain them without executing until Enter.
      queueInput("\x1b[200~" + value + "\x1b[201~");
    });
    editor.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        if (editor.value && historyRef.current.at(-1) !== editor.value) historyRef.current.push(editor.value);
        historyRef.current = historyRef.current.slice(-100);
        sendEditor("\r");
      } else if (event.key === "Tab") {
        event.preventDefault();
        sendEditor("\t");
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        historyIndexRef.current = Math.max(0, Math.min(historyRef.current.length,
          historyIndexRef.current + (event.key === "ArrowUp" ? -1 : 1)));
        editor.value = historyRef.current[historyIndexRef.current] ?? "";
        editor.setSelectionRange(editor.value.length, editor.value.length);
      } else if (event.ctrlKey && !event.altKey && !event.metaKey) {
        const key = event.key.toLowerCase();
        if (key === "c") { event.preventDefault(); leavePrompt(); terminal.focus(); queueInput("\x03"); }
        else if (key === "u") { event.preventDefault(); editor.value = editor.value.slice(editor.selectionEnd ?? 0); editor.setSelectionRange(0, 0); }
        else if (key === "a" || key === "e") { event.preventDefault(); const pos = key === "a" ? 0 : editor.value.length; editor.setSelectionRange(pos, pos); }
        else if (key === "d" || key === "r" || key === "l" || key === "z") {
          event.preventDefault(); sendEditor(String.fromCharCode(key.charCodeAt(0) - 96));
        }
      }
    });
    const inputDisposable = terminal.onData((data) => {
      // Focus can briefly lag a parsed prompt. Route printable text locally.
      if (atPrompt && /^[^\x00-\x1f\x7f]+$/.test(data)) {
        editor.value += data; editor.focus(); return;
      }
      if (atPrompt) leavePrompt();
      queueInput(data);
    });
    let resizeTimer: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        fitTerminal();
        if (terminal.cols !== lastCols || terminal.rows !== lastRows) {
          sizeDirty = true;
          schedule();
        }
      }, 90);
    });
    resizeObserver.observe(mount.parentElement ?? mount);
    offsetRef.current = 0;
    decoderRef.current = new TextDecoder();
    schedule();

    const onVisibility = () => {
      if (!document.hidden) schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const restart = () => {
      pendingInput = "";
      submissionPending = false;
      submissionEchoed = false;
      leavePrompt();
      restarting = true;
      setConnection("connecting");
      terminal.focus();
      schedule();
    };
    const clear = () => {
      terminal.clear();
      if (atPrompt) sendEditor("\u000c");
      else { terminal.focus(); queueInput("\u000c"); }
    };
    const sendCommand = (event: Event) => {
      const data = (event as CustomEvent<string>).detail;
      if (typeof data === "string") {
        submissionPending = false; submissionEchoed = false;
        leavePrompt(); queueInput(data);
      }
    };
    window.addEventListener("terminal:input", sendCommand);
    window.addEventListener("terminal:restart", restart);
    window.addEventListener("terminal:clear", clear);

    return () => {
      active = false;
      inputDisposable.dispose();
      promptMarker.dispose(); parsed.dispose(); scrolled.dispose(); rendered.dispose(); editor.remove();
      mount.removeEventListener("pointerdown", focusTerminal, { capture: true });
      mount.removeEventListener("click", focusTerminal);
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("terminal:input", sendCommand);
      window.removeEventListener("terminal:restart", restart);
      window.removeEventListener("terminal:clear", clear);
      if (timer !== null) window.clearTimeout(timer);
      if (writeTimer !== null) window.clearTimeout(writeTimer);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  return (
    <main className="terminal-app">
      <header className="terminal-toolbar pt-safe">
        <div className="connection" role="status" aria-live="polite">
          <span className={`connection-dot ${connection}`} aria-hidden="true" />
          <span>{connection}</span>
          <span className="command" aria-hidden="true">·</span>
          <span className="command">{command}</span>
        </div>
      </header>
      <section className="terminal-stage" aria-label="Interactive terminal">
        <div ref={mountRef} className="terminal-mount" />
      </section>
    </main>
  );
}
