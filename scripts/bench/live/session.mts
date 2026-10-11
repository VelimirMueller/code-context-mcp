/**
 * Agent child process control for `bench:live` (CCA-15, #146).
 *
 * `runAgentProcess` spawns the agent CLI in its own process group and ends it
 * reliably at the session timeout:
 *
 *   - The deadline is checked against the WALL clock (Date.now) on a 1 s tick.
 *     A plain setTimeout runs on the monotonic clock, which on macOS stops
 *     while the machine sleeps: on 2026-10-11 the Mac idle-slept on battery
 *     (pmset `sleep 1`) and woke for ~20 s every ~15 min, so a 300 s timer
 *     never fired and sessions recorded ~900 s wall times with stalled or
 *     0-call output. A tick gap far above the tick interval means the machine
 *     slept during the session (`slept: true`).
 *   - At the deadline: SIGTERM to the process group AND to every descendant
 *     found via `ps` (a child that moved into its own group or session still
 *     dies), then SIGKILL to the same set after a grace period.
 *   - The result never waits on the stdout/stderr pipes beyond a short drain
 *     window after the child exits: a grandchild that inherited the pipe
 *     cannot keep the session open. Leftover processes are killed.
 *   - Output read so far is returned, so a timed-out session keeps its
 *     partial usage.
 */
import { execFileSync, spawn } from 'node:child_process';

export interface AgentProcessOpts {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** SIGTERM → SIGKILL grace period. Default 5 000 ms. */
  graceMs?: number;
  /** How long to wait for the pipes to close after the child exits. Default 2 000 ms. */
  drainMs?: number;
  /** Deadline tick. Default 1 000 ms (lower in tests). */
  tickMs?: number;
  /** A tick gap above this means the machine slept. Default 30 000 ms. */
  sleepGapMs?: number;
}

export interface AgentProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  /** The machine slept (wall-clock gap) while the session ran. */
  slept: boolean;
  /** Spawn failure (e.g. ENOENT); empty when the child ran. */
  spawnError: string;
  wallMs: number;
}

/** All descendants of `root` (children, grandchildren, …) from one `ps` snapshot. */
export function descendantPids(root: number): number[] {
  let table: string;
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const p = queue.shift() as number;
    for (const c of children.get(p) ?? []) {
      if (c === process.pid || out.includes(c)) continue;
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}

export async function runAgentProcess(opts: AgentProcessOpts): Promise<AgentProcessResult> {
  const graceMs = opts.graceMs ?? 5_000;
  const drainMs = opts.drainMs ?? 2_000;
  const tickMs = opts.tickMs ?? 1_000;
  const sleepGapMs = opts.sleepGapMs ?? 30_000;
  const t0 = Date.now();
  let timedOut = false;
  let slept = false;
  let spawnError = '';

  const child = spawn(opts.bin, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true, // own process group: -pid reaches the whole group
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
  child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

  // Every pid seen under the child, so a descendant that outlives its parent
  // (reparented to init) is still killed.
  const known = new Set<number>();
  const snapshot = (): void => {
    if (!pid) return;
    for (const d of descendantPids(pid)) known.add(d);
  };
  const killAll = (sig: NodeJS.Signals): void => {
    if (!pid) return;
    snapshot();
    signal(-pid, sig);
    signal(pid, sig);
    for (const d of known) signal(d, sig);
  };

  let exited = false;
  let closed = false;
  const exitedP = new Promise<void>((resolve) => {
    child.on('exit', () => {
      exited = true;
      resolve();
    });
    child.on('error', (err: Error) => {
      spawnError = err.message;
      exited = true;
      closed = true;
      resolve();
    });
  });
  const closedP = new Promise<void>((resolve) => {
    child.on('close', () => {
      closed = true;
      resolve();
    });
    child.on('error', () => resolve());
  });

  let lastTick = Date.now();
  let killTimer: NodeJS.Timeout | undefined;
  const ticker = setInterval(() => {
    const now = Date.now();
    if (now - lastTick > sleepGapMs) slept = true;
    lastTick = now;
    if (!exited) snapshot();
    if (!timedOut && !exited && now - t0 >= opts.timeoutMs) {
      timedOut = true;
      killAll('SIGTERM');
      killTimer = setTimeout(() => {
        if (!exited) killAll('SIGKILL');
      }, graceMs);
    }
  }, tickMs);

  await exitedP;
  clearInterval(ticker);
  clearTimeout(killTimer);
  if (Date.now() - lastTick > sleepGapMs) slept = true;

  if (!spawnError) {
    // Do not wait on the pipes forever: a descendant holding them keeps
    // 'close' from firing. Give them a short drain window, then end
    // whatever is left of the tree and stop reading.
    let drainTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      closedP,
      new Promise<void>((r) => {
        drainTimer = setTimeout(r, drainMs);
      }),
    ]);
    clearTimeout(drainTimer);
    // Leftovers (MCP server, helpers) never outlive the session.
    killAll('SIGKILL');
    if (!closed) {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }

  return {
    stdout: Buffer.concat(stdoutChunks),
    stderr: Buffer.concat(stderrChunks),
    timedOut,
    slept,
    spawnError,
    wallMs: Date.now() - t0,
  };
}

/** What the runner needs to decide whether an attempt counts. */
export interface AttemptSignals {
  providerError: string | null;
  modelCalls: number;
  slept?: boolean;
  timeout?: boolean;
}

/**
 * Why an attempt is not a model result (#112, #146), or null when it is.
 * A provider error, a session in which the model never answered (also a
 * timeout with 0 model calls) and a session the machine slept through are
 * harness or provider faults: retried once, and the run is voided when the
 * retry fails too. A timeout WITH model calls is a normal model FAIL.
 */
export function attemptFault(a: AttemptSignals): string | null {
  if (a.providerError) return `provider error: ${a.providerError}`;
  if (a.modelCalls === 0) {
    return a.timeout
      ? 'the model never answered (0 model calls, timeout)'
      : 'the model never answered (0 model calls)';
  }
  if (a.slept) return 'the machine slept during the session';
  return null;
}

/**
 * macOS: hold an idle-sleep assertion (`caffeinate -i`) for as long as this
 * process lives (`-w <pid>`), so a run on battery does not idle-sleep in the
 * middle of a session. A closed lid still sleeps; the wall-clock deadline and
 * the `slept` flag cover that. Returns false when it could not be started
 * (not macOS, or no caffeinate on PATH).
 */
export function preventIdleSleep(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    const c = spawn('caffeinate', ['-i', '-w', String(process.pid)], {
      stdio: 'ignore',
      detached: true,
    });
    c.on('error', () => {
      /* no caffeinate: the wall-clock deadline still holds */
    });
    c.unref();
    return typeof c.pid === 'number';
  } catch {
    return false;
  }
}
