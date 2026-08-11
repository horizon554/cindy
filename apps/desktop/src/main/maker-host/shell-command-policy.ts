/**
 * Product-owned shell command policy for the embedded iOS Simulator.
 *
 * **Threat model: a stale recipe.** A Skill, a README or the model's own memory
 * still carries a pre-Cindy incantation (`xcrun simctl boot …`,
 * `open -a Simulator`) and the Agent copies it verbatim. Such recipes are
 * literal by construction — they come from documentation, so they never disguise
 * themselves — and a literal matcher catches all of them. Cindy's own main
 * process reaches simctl through the runtime adapter and is unaffected, and the
 * capability gate means this policy only applies where an embedded simulator
 * actually exists to protect.
 *
 * **Deliberately outside the threat model: writing around this policy.** Command
 * text cannot decide that case at all — `bash script.sh` moves the executor out
 * of the command entirely, and no amount of parsing recovers it. Trying anyway is
 * what made this module deny ordinary work: it had to fail closed on every shape
 * it could not resolve, and in shell that is most shapes, so `print(len(data))`
 * in a heredoc, `(( n > 1 ))`, a glob-leading line, `{ …; } > file` and a commit
 * message containing a Markdown backtick were all rejected with no Simulator
 * executor anywhere in the command. This matcher denies only what it can read
 * directly and lets everything else reach the normal shell permission flow.
 *
 * A useful consequence: a recipe delivered through a heredoc needs no heredoc
 * modelling. Bodies are split into segments like any other text, and a body line
 * only matters when it literally spells out a Simulator command — so
 * `git commit -F - <<'MSG'` carrying backticks is simply not a match.
 */

export interface ShellCommandPolicyDenial {
  decision: 'deny';
  reason: string;
}

const SAFE_SIMCTL_COMMANDS = new Set([
  'help',
  'list',
  'listapps',
  'getenv',
  'get_app_container',
  'diagnose',
]);

const IOS_SIMULATOR_SHELL_DENIAL =
  'Cindy blocked a shell command that would bypass the embedded iOS Simulator. ' +
  'Use cindy_ios_simulator for device lifecycle, app install/launch, interaction, screenshots, and diagnostics.';

const MAX_RECURSION_DEPTH = 8;

/** Split command lists without treating separators inside quotes as boundaries. */
function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }
    if (char === '\n' || char === ';' || char === '|' || char === '&') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/** Lightweight argv tokenizer. Quotes group tokens but are not retained. */
function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let started = false;
  let quote: "'" | '"' | null = null;
  const flush = (): void => {
    if (!started) return;
    tokens.push(token);
    token = '';
    started = false;
  };
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (char === '\\' && quote !== "'" && index + 1 < segment.length) {
      token += segment[index + 1]!;
      started = true;
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      flush();
    } else {
      token += char;
      started = true;
    }
  }
  flush();
  return tokens;
}

function executableName(token: string | undefined): string {
  return (token ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .at(-1)!
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

/** Drop compound-command keywords and braces so the next token is the command word. */
function stripShellControlTokens(tokens: string[]): string[] {
  const out = [...tokens];
  while (out.length > 0 && /^(?:\{|\(|!|then|do|else|elif|if|while|until)$/.test(out[0]!)) {
    out.shift();
  }
  if (out[0]) out[0] = out[0].replace(/^[({]+/, '');
  while (out[0] === '') out.shift();
  const last = out.length - 1;
  if (last >= 0) {
    // A trailing `)` may close a substitution rather than a subshell. Stripping
    // it there would truncate `CMD='echo $(xcrun simctl boot X)'` into an
    // unterminated substitution that the recursive scan can no longer read.
    const closesSubstitution = /\$\(|<\(|>\(/.test(out[last]!);
    if (!closesSubstitution) {
      out[last] = out[last]!.replace(/[)}]+$/, '');
      if (out[last] === '') out.pop();
    }
  }
  return out;
}

function shellRedirectionSuffix(token: string): string | null {
  const match = /^(?:\d+)?(?:<<<|<<-?|<>|<|>>?|>&|<&|>\|)(.*)$/s.exec(token);
  return match ? (match[1] ?? '') : null;
}

interface Preamble {
  tokens: string[];
  /** Values of leading `NAME=value` assignments, which may hold a whole recipe. */
  assignedValues: string[];
}

/** Remove leading assignments and redirections so the next token is the command word. */
function stripLeadingShellPreamble(input: string[]): Preamble {
  const tokens = [...input];
  const assignedValues: string[] = [];
  while (tokens.length > 0) {
    const token = tokens[0]!;
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=([\s\S]*)$/.exec(token);
    if (assignment) {
      assignedValues.push(assignment[1] ?? '');
      tokens.shift();
      continue;
    }
    const redirectionSuffix = shellRedirectionSuffix(token);
    if (redirectionSuffix === null) break;
    tokens.shift();
    if (redirectionSuffix === '' && tokens.length > 0) tokens.shift();
  }
  return { tokens, assignedValues };
}

const SHELL_EXECUTABLES = new Set(['bash', 'csh', 'dash', 'fish', 'ksh', 'sh', 'tcsh', 'zsh']);
const PROGRAMMABLE_INTERPRETER =
  /^(?:python(?:\d+(?:\.\d+)*)?|pypy(?:\d+(?:\.\d+)*)?|node|nodejs|bun|deno|ruby(?:\d+(?:\.\d+)*)?|perl(?:\d+(?:\.\d+)*)?|php(?:\d+(?:\.\d+)*)?|lua(?:\d+(?:\.\d+)*)?|luajit|swift|expect(?:\d+(?:\.\d+)*)?|tclsh(?:\d+(?:\.\d+)*)?|wish(?:\d+(?:\.\d+)*)?|(?:g|m|n)?awk|osascript)$/;

/**
 * Prefixes documentation puts in front of a recipe. Peeling is best-effort: an
 * unfamiliar option shape simply stops the peel, because mislocating the command
 * word now costs a missed literal instead of a denied ordinary command.
 */
const LITERAL_COMMAND_PREFIXES = new Set([
  'arch',
  'builtin',
  'caffeinate',
  'command',
  'env',
  'exec',
  'gtimeout',
  'nice',
  'nocorrect',
  'noglob',
  'nohup',
  'sudo',
  'time',
  'timeout',
  'xargs',
]);

/**
 * Options of those prefixes that consume the following token. Without this,
 * `env -u FOO xcrun simctl …` reads `FOO` as the command and the peel stops
 * short of a recipe that is spelled out in full. Separate-word spellings only:
 * an `--opt=value` form starts with `-` and is skipped as a plain flag.
 */
const PREFIX_VALUE_OPTIONS: Record<string, RegExp> = {
  arch: /^(?:-arch|--arch|-d|-e)$/,
  caffeinate: /^(?:-t|-w)$/,
  env: /^(?:-u|--unset|-C|--chdir|-S|--split-string)$/,
  gtimeout: /^(?:-k|-s|--kill-after|--signal)$/,
  nice: /^(?:-n|--adjustment)$/,
  sudo: /^(?:-u|--user|-g|--group|-h|--host|-p|--prompt|-C|--close-from|-D|--chdir|-R|--chroot|-T|--command-timeout|-U|--other-user|-r|--role)$/,
  timeout: /^(?:-k|-s|--kill-after|--signal)$/,
  xargs:
    /^(?:-n|--max-args|-L|--max-lines|-I|--replace|-P|--max-procs|-s|--max-chars|-E|--eof)$/,
};

interface UnwrappedCommand {
  tokens: string[];
  /** A literal program string handed to a shell via `-c`, classified recursively. */
  nestedShell: string | null;
  assignedValues: string[];
}

/** Peel documentation-style prefixes to reach the command word. */
function unwrapCommand(input: string[]): UnwrappedCommand {
  const first = stripLeadingShellPreamble(stripShellControlTokens(input));
  let tokens = first.tokens;
  const assignedValues = [...first.assignedValues];
  for (let depth = 0; depth < MAX_RECURSION_DEPTH; depth += 1) {
    const peeled = stripLeadingShellPreamble(tokens);
    tokens = peeled.tokens;
    assignedValues.push(...peeled.assignedValues);
    if (tokens.length === 0) return { tokens, nestedShell: null, assignedValues };
    const head = executableName(tokens[0]);

    if (SHELL_EXECUTABLES.has(head)) {
      const flag = tokens.findIndex((token) => /^-[A-Za-z]*c[A-Za-z]*$/.test(token));
      if (flag > 0) return { tokens: [], nestedShell: tokens[flag + 1] ?? '', assignedValues };
      return { tokens, nestedShell: null, assignedValues };
    }
    if (head === 'eval') {
      return { tokens: [], nestedShell: tokens.slice(1).join(' '), assignedValues };
    }
    if (!LITERAL_COMMAND_PREFIXES.has(head)) return { tokens, nestedShell: null, assignedValues };

    const valueOptions = PREFIX_VALUE_OPTIONS[head];
    let index = 1;
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (token === '--') {
        index += 1;
        break;
      }
      if (!token.startsWith('-')) break;
      index += valueOptions?.test(token) ? 2 : 1;
    }
    // timeout takes a duration operand before the command it runs.
    if ((head === 'timeout' || head === 'gtimeout') && /^[\d.]+[smhd]?$/.test(tokens[index] ?? '')) {
      index += 1;
    }
    const next = tokens.slice(index);
    if (next.length === 0 || next.length === tokens.length) {
      return { tokens: next, nestedShell: null, assignedValues };
    }
    tokens = next;
  }
  return { tokens, nestedShell: null, assignedValues };
}

/** `open -a Simulator` and the Simulator binary, in their documented spellings. */
function isExternalSimulatorLaunch(tokens: string[]): boolean {
  const head = executableName(tokens[0]);
  if (head === 'open') {
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      const next = tokens[index + 1];
      if (/^-[^-]*a[^-]*$/i.test(token) && /^Simulator(?:\.app)?$/i.test(next ?? '')) return true;
      if (/^-aSimulator(?:\.app)?$/i.test(token)) return true;
      if (/^-[^-]*b[^-]*$/i.test(token) && /^com\.apple\.iphonesimulator$/i.test(next ?? '')) {
        return true;
      }
      if (/^-bcom\.apple\.iphonesimulator$/i.test(token)) return true;
      if (/\/Simulator\.app(?:\/Contents\/MacOS\/Simulator)?$/i.test(token)) return true;
    }
  }
  return (
    head === 'simulator' && /Simulator\.app\/Contents\/MacOS\/Simulator$/i.test(tokens[0] ?? '')
  );
}

/** The simctl subcommand of a literal `[xcrun] simctl …` invocation, or null. */
function simctlSubcommand(tokens: string[]): string | null {
  let index = 0;
  if (executableName(tokens[index]) === 'xcrun') {
    index += 1;
    while (index < tokens.length && tokens[index]!.startsWith('-')) {
      const option = tokens[index]!;
      const takesValue =
        option === '--sdk' ||
        option === '-sdk' ||
        option === '--toolchain' ||
        option === '-toolchain';
      index += takesValue ? 2 : 1;
    }
  }
  if (executableName(tokens[index]) !== 'simctl') return null;
  index += 1;
  if (tokens[index] === '--set') index += 2;
  return tokens[index]?.toLowerCase() ?? null;
}

function isSimulatorMutation(tokens: string[]): boolean {
  const subcommand = simctlSubcommand(tokens);
  return subcommand !== null && !SAFE_SIMCTL_COMMANDS.has(subcommand);
}

function isSimulatorRecipeArgv(tokens: string[]): boolean {
  return isExternalSimulatorLaunch(tokens) || isSimulatorMutation(tokens);
}

/** A Simulator command spelled out in free text, used for interpreter payloads. */
function containsLiteralSimulatorExecutor(value: string): boolean {
  const argvLike = value.replace(/[^A-Za-z0-9_./-]+/g, ' ').trim();
  return (
    /\bxcrun\b[\s\S]*\bsimctl\b/i.test(value) ||
    /(?:^|[^\w./-])simctl\s+\S/i.test(argvLike) ||
    /\bSimulator\.app\b/i.test(value) ||
    /\bcom\.apple\.iphonesimulator\b/i.test(value) ||
    /(?:^|\s)(?:\S*\/)?open(?:\s+-[A-Za-z]+)*\s+Simulator(?:\.app)?(?:\s|$)/i.test(argvLike)
  );
}

/**
 * A recipe pasted into an interpreter one-liner (`python3 -c 'os.system("xcrun
 * simctl boot X")'`) is still literal, so the payload is scanned as text. Only a
 * spelled-out command counts; assembling one from fragments is outside the threat
 * model.
 */
function containsInterpreterSimulatorPayload(tokens: string[]): boolean {
  if (!PROGRAMMABLE_INTERPRETER.test(executableName(tokens[0]))) return false;
  return containsLiteralSimulatorExecutor(tokens.slice(1).join('\n'));
}

/** Command and process substitutions execute, so their contents are classified too. */
function shellSubcommands(command: string): string[] {
  const subcommands: string[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (char === "'") {
      if (quote === "'") quote = null;
      else if (quote === null) quote = "'";
      continue;
    }
    if (char === '"') {
      if (quote === '"') quote = null;
      else if (quote === null) quote = '"';
      continue;
    }
    if (quote === "'") continue;
    if (char === '`') {
      let end = index + 1;
      for (; end < command.length; end += 1) {
        if (command[end] === '\\') end += 1;
        else if (command[end] === '`') break;
      }
      if (end < command.length) {
        subcommands.push(command.slice(index + 1, end));
        index = end;
      }
      continue;
    }
    if ((char === '$' || char === '<' || char === '>') && command[index + 1] === '(') {
      let depth = 1;
      let innerQuote: "'" | '"' | null = null;
      let end = index + 2;
      for (; end < command.length && depth > 0; end += 1) {
        const inner = command[end]!;
        if (inner === '\\' && innerQuote !== "'") {
          end += 1;
          continue;
        }
        if (inner === "'" || inner === '"') {
          if (innerQuote === inner) innerQuote = null;
          else if (innerQuote === null) innerQuote = inner;
          continue;
        }
        if (innerQuote) continue;
        if (inner === '(') depth += 1;
        else if (inner === ')') depth -= 1;
      }
      if (depth === 0) {
        subcommands.push(command.slice(index + 2, end - 1));
        index = end - 1;
      }
    }
  }
  return subcommands;
}

function containsSimulatorRecipe(command: string, depth = 0): boolean {
  if (depth > MAX_RECURSION_DEPTH) return false;
  for (const nested of shellSubcommands(command)) {
    if (containsSimulatorRecipe(nested, depth + 1)) return true;
  }
  for (const segment of shellSegments(command)) {
    const unwrapped = unwrapCommand(tokenizeShellSegment(segment));
    // `CMD="xcrun simctl boot $UDID"` holds a whole recipe; documentation does
    // write it this way before running it. The value goes through the same
    // classifier as a command, so a documented prefix (`sudo …`, `env FOO=1 …`),
    // a nested `bash -lc '…'` or a substitution inside the value is reached too.
    for (const value of unwrapped.assignedValues) {
      if (containsSimulatorRecipe(value, depth + 1)) return true;
    }
    if (unwrapped.nestedShell !== null) {
      if (containsSimulatorRecipe(unwrapped.nestedShell, depth + 1)) return true;
      continue;
    }
    if (isSimulatorRecipeArgv(unwrapped.tokens)) return true;
    if (containsInterpreterSimulatorPayload(unwrapped.tokens)) return true;
  }
  return false;
}

/** Undefined means the normal shell permission flow remains unchanged. */
export function getDesktopShellCommandPolicy(
  command: string,
): ShellCommandPolicyDenial | undefined {
  if (process.platform !== 'darwin') return undefined;
  // POSIX shells remove an unquoted backslash-newline before tokenization.
  const expandedCommand = command.replace(/\\\r?\n/g, '');
  if (containsSimulatorRecipe(expandedCommand)) {
    return { decision: 'deny', reason: IOS_SIMULATOR_SHELL_DENIAL };
  }
  return undefined;
}

export const iosSimulatorShellDenialReason = IOS_SIMULATOR_SHELL_DENIAL;
