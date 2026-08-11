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
 * Heredocs need one narrow boundary: their bodies are stdin data unless the
 * receiving command executes stdin as a program. Data bodies are omitted from
 * command classification (while substitutions in an unquoted body still run),
 * so a commit message may quote a stale recipe without being mistaken for one.
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

interface ShellSegment {
  command: string;
  /** The operator that ran before this command; null for the first segment. */
  precedingOperator: ';' | '&&' | '||' | '|' | '&' | null;
  /** The operator that separates this command from the next segment, if any. */
  followingOperator: ';' | '&&' | '||' | '|' | '&' | null;
}

/** Split command lists without treating separators inside quotes as boundaries. */
function shellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let atWordStart = true;
  let precedingOperator: ShellSegment['precedingOperator'] = null;

  const flush = (nextOperator: Exclude<ShellSegment['precedingOperator'], null>): void => {
    if (current.trim()) {
      segments.push({
        command: current.trim(),
        precedingOperator,
        followingOperator: nextOperator,
      });
    }
    current = '';
    precedingOperator = nextOperator;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      current += char;
      escaped = false;
      atWordStart = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      current += char;
      escaped = true;
      atWordStart = false;
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
      atWordStart = false;
      continue;
    }
    if (char === '#' && atWordStart) {
      // A comment consumes the rest of the current physical line. Keep the
      // newline for the normal separator handling so assignments before the
      // comment retain their real shell scope.
      const newline = command.indexOf('\n', index);
      if (newline < 0) break;
      index = newline - 1;
      continue;
    }
    if (char === '\n' || char === ';') {
      // A newline immediately after `&&`, `||` or `|` continues that operator's
      // command. There is no empty command for the newline to run, so keep the
      // pending edge instead of turning it into an unconditional list separator.
      // A lone `&` is already a complete separator, so the next line is
      // unconditional in the parent shell.
      if (char === ';' || current.trim() || precedingOperator === '&') flush(';');
      atWordStart = true;
      continue;
    }
    if (
      (char === '&' && (command[index - 1] === '>' || command[index - 1] === '<')) ||
      (char === '&' && command[index + 1] === '>') ||
      (char === '|' && command[index - 1] === '>')
    ) {
      current += char;
      atWordStart = false;
      continue;
    }
    if (char === '|' || char === '&') {
      if (char === '|' && command[index + 1] === '&') {
        flush('|');
        index += 1;
        continue;
      }
      const doubled = command[index + 1] === char;
      flush(doubled ? (char === '|' ? '||' : '&&') : char);
      if (doubled) index += 1;
      atWordStart = true;
      continue;
    }
    current += char;
    atWordStart = /\s/.test(char);
  }
  if (current.trim())
    segments.push({ command: current.trim(), precedingOperator, followingOperator: null });
  return segments;
}

/** Whether a segment's assignments definitely replace values in the current scope. */
function assignmentDefinitelyRunsInCurrentScope(segment: ShellSegment): boolean {
  if (segment.precedingOperator !== null && segment.precedingOperator !== ';') return false;
  // Assignments in a pipeline or background segment execute in a child shell.
  // They must not be treated as replacing the value in the parent scope that a
  // later command (for example `eval "$CMD"`) will read.
  if (segment.followingOperator === '|' || segment.followingOperator === '&') return false;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let unquoted = '';
  for (const char of segment.command) {
    if (escaped) {
      unquoted += ' ';
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      unquoted += ' ';
      escaped = true;
      continue;
    }
    if (quote) {
      unquoted += ' ';
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      unquoted += ' ';
      quote = char;
      continue;
    }
    if (char === '(' || char === ')' || char === '`') return false;
    unquoted += char;
  }
  const start = unquoted.trimStart();
  return !/^(?:(?:\{|!)\s*|(?:then|do|else|elif|if|while|until|for|select|case|function)\b)/.test(
    start,
  );
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

function redirectionAt(segment: string, index: number): string | null {
  if (
    (segment[index] === '<' || segment[index] === '>')
    && segment[index + 1] === '('
  ) return null;
  const wordStart = index === 0 || /\s/.test(segment[index - 1]!);
  const prefix = wordStart ? '(?:(?:\\d+|\\{[A-Za-z_][A-Za-z0-9_]*\\}))?' : '';
  return new RegExp(`^${prefix}(?:&>>?|<<<|<<-|<<|<>|>>|>&|<&|>\\||<|>)`).exec(
    segment.slice(index),
  )?.[0] ?? null;
}

/** Remove unquoted redirections before deciding whether stdin is the program. */
function tokenizeHeredocConsumer(segment: string): string[] {
  let command = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (escaped) {
      command += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      command += char;
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      command += char;
      if (quote === char) quote = null;
      else if (quote === null) quote = char;
      continue;
    }
    const redirection = quote === null ? redirectionAt(segment, index) : null;
    if (redirection === null) {
      command += char;
      continue;
    }
    index += redirection.length;
    while (/\s/.test(segment[index] ?? '')) index += 1;
    let targetQuote: "'" | '"' | null = null;
    let targetEscaped = false;
    for (; index < segment.length; index += 1) {
      const target = segment[index]!;
      if (targetEscaped) {
        targetEscaped = false;
        continue;
      }
      if (target === '\\' && targetQuote !== "'") {
        targetEscaped = true;
        continue;
      }
      if (target === "'" || target === '"') {
        if (targetQuote === target) targetQuote = null;
        else if (targetQuote === null) targetQuote = target;
        continue;
      }
      if (targetQuote === null && (/\s/.test(target) || redirectionAt(segment, index))) break;
    }
    command += ' ';
    index -= 1;
  }
  return tokenizeShellSegment(command);
}

/** A `NAME=value` assignment, whose value may hold a whole recipe. */
interface ShellAssignment {
  name: string;
  value: string;
}

const SHELL_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

interface Preamble {
  tokens: string[];
  assignments: ShellAssignment[];
}

/** Remove leading assignments and redirections so the next token is the command word. */
function stripLeadingShellPreamble(input: string[]): Preamble {
  const tokens = [...input];
  const assignments: ShellAssignment[] = [];
  while (tokens.length > 0) {
    const token = tokens[0]!;
    const assignment = SHELL_ASSIGNMENT.exec(token);
    if (assignment) {
      assignments.push({ name: assignment[1] ?? '', value: assignment[2] ?? '' });
      tokens.shift();
      continue;
    }
    const redirectionSuffix = shellRedirectionSuffix(token);
    if (redirectionSuffix === null) break;
    tokens.shift();
    if (redirectionSuffix === '' && tokens.length > 0) tokens.shift();
  }
  return { tokens, assignments };
}

const SHELL_EXECUTABLES = new Set(['bash', 'csh', 'dash', 'fish', 'ksh', 'sh', 'tcsh', 'zsh']);
const PROGRAMMABLE_INTERPRETER =
  /^(?:python(?:\d+(?:\.\d+)*)?|pypy(?:\d+(?:\.\d+)*)?|node|nodejs|bun|deno|ruby(?:\d+(?:\.\d+)*)?|perl(?:\d+(?:\.\d+)*)?|php(?:\d+(?:\.\d+)*)?|lua(?:\d+(?:\.\d+)*)?|luajit|swift|expect(?:\d+(?:\.\d+)*)?|tclsh(?:\d+(?:\.\d+)*)?|wish(?:\d+(?:\.\d+)*)?|(?:g|m|n)?awk|osascript)$/;

/**
 * Prefixes documentation puts in front of a recipe, in the plain spelling it
 * actually uses: `sudo xcrun simctl …`, `env FOO=1 xcrun simctl …`,
 * `timeout 30 xcrun simctl …`.
 *
 * **An option on the prefix ends the peel.** Reading past one means knowing that
 * CLI's option arity *and* whether its operands are executed at all — `sudo -l`
 * and `command -v` merely report on the command they name. Both kinds of
 * knowledge were a standing source of defects here, in the direction that
 * matters: getting either wrong denies ordinary work. Stopping can only miss,
 * and a recipe copied out of documentation does not arrive decorated with
 * options.
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

interface UnwrappedCommand {
  tokens: string[];
  /** A literal program string handed to a shell via `-c`, classified recursively. */
  nestedShell: string | null;
  assignments: ShellAssignment[];
}

/** Builtins that declare `NAME=value`, an equally standard way to store a recipe. */
const SHELL_ASSIGNMENT_BUILTINS = new Set([
  'declare',
  'export',
  'local',
  'readonly',
  'typeset',
]);

/** Peel documentation-style prefixes to reach the command word. */
function unwrapCommand(input: string[]): UnwrappedCommand {
  const first = stripLeadingShellPreamble(stripShellControlTokens(input));
  let tokens = first.tokens;
  const assignments = [...first.assignments];
  for (let depth = 0; depth < MAX_RECURSION_DEPTH; depth += 1) {
    const peeled = stripLeadingShellPreamble(tokens);
    tokens = peeled.tokens;
    assignments.push(...peeled.assignments);
    if (tokens.length === 0) return { tokens, nestedShell: null, assignments };
    const head = executableName(tokens[0]);

    if (SHELL_ASSIGNMENT_BUILTINS.has(head)) {
      // `export CMD='xcrun simctl …'` stores the recipe just like a bare
      // assignment, so its operands feed the same stored-value path.
      for (const token of tokens.slice(1)) {
        const assignment = SHELL_ASSIGNMENT.exec(token);
        if (assignment) {
          assignments.push({ name: assignment[1] ?? '', value: assignment[2] ?? '' });
        }
      }
      return { tokens: [], nestedShell: null, assignments };
    }

    if (SHELL_EXECUTABLES.has(head)) {
      // Only leading options belong to the shell. `bash ./run.sh -c 'x'` passes
      // `-c` to the script as `$1`, so scanning the whole argv would classify an
      // ordinary script argument as an executed shell program.
      let index = 1;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === '--') break;
        if (!token.startsWith('-') && !token.startsWith('+')) break;
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(token)) {
          return { tokens: [], nestedShell: tokens[index + 1] ?? '', assignments };
        }
        // `-o name` and `-O shopt_option` take a value; skipping one token would
        // read the option's value as the script operand and end the scan early.
        index += /^[-+][oO]$/.test(token) ? 2 : 1;
      }
      return { tokens, nestedShell: null, assignments };
    }
    if (head === 'eval') {
      return { tokens: [], nestedShell: tokens.slice(1).join(' '), assignments };
    }
    if (!LITERAL_COMMAND_PREFIXES.has(head)) return { tokens, nestedShell: null, assignments };

    let index = 1;
    if (tokens[index] === '--') {
      // The only option-like token whose meaning needs no per-CLI knowledge.
      index += 1;
    } else if (tokens[index]?.startsWith('-')) {
      return { tokens, nestedShell: null, assignments };
    }
    // timeout takes a duration operand before the command it runs.
    if ((head === 'timeout' || head === 'gtimeout') && /^[\d.]+[smhd]?$/.test(tokens[index] ?? '')) {
      index += 1;
    }
    const next = tokens.slice(index);
    if (next.length === 0 || next.length === tokens.length) {
      return { tokens: next, nestedShell: null, assignments };
    }
    tokens = next;
  }
  return { tokens, nestedShell: null, assignments };
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

function nestedShellConsumesStdinAsProgram(command: string): boolean {
  return (
    /(?:^|[;&|]\s*)(?:source|\.)\s+(?:\/dev\/stdin|\/dev\/fd\/0|-)(?:\s|$)/i.test(command) ||
    /\beval\b[\s\S]*\$\(\s*cat(?:\s+(?:-|\/dev\/stdin|\/dev\/fd\/0))?\s*\)/i.test(command)
  );
}

/** Whether this literal command executes its stdin as source code. */
function consumesStdinAsProgram(tokens: string[]): boolean {
  const unwrapped = unwrapCommand(tokens);
  if (unwrapped.nestedShell !== null) {
    return nestedShellConsumesStdinAsProgram(unwrapped.nestedShell);
  }
  const executable = executableName(unwrapped.tokens[0]);
  const args = unwrapped.tokens.slice(1);
  if (SHELL_EXECUTABLES.has(executable)) {
    if (args.some((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))) return false;
    if (args.some((arg) => /^-[A-Za-z]*s[A-Za-z]*$/.test(arg))) return true;
  } else if (executable === 'osascript') {
    if (args.some((arg) => arg === '-e' || arg.startsWith('-e'))) return false;
  } else if (PROGRAMMABLE_INTERPRETER.test(executable)) {
    if (/^(?:(?:g|m|n)?awk)$/.test(executable)) return false;
    if (args.some((arg) => /^(?:-c|-e|-p|-m|--eval|--print|--input-type|--module)$/.test(arg))) {
      return false;
    }
  } else {
    return false;
  }
  const positional = args.find((arg) => !arg.startsWith('-'));
  return positional === undefined || positional === '-';
}

interface HeredocRedirection {
  marker: string;
  delimiter: string;
  expands: boolean;
  stripsTabs: boolean;
}

/** Heredoc markers on one shell line, excluding quoted text, comments and `<<<`. */
function heredocRedirections(line: string): HeredocRedirection[] {
  const redirections: HeredocRedirection[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null;
      else if (quote === null) quote = char;
      continue;
    }
    if (quote) continue;
    // In shell grammar `#` starts a comment when it begins a word. A marker in
    // that comment must not consume later commands as a fake heredoc body.
    if (char === '#' && (index === 0 || /[\s;&|()]/.test(line[index - 1]!))) break;
    if (char !== '<' || line[index + 1] !== '<' || line[index + 2] === '<') continue;
    let cursor = index + 2;
    const stripsTabs = line[cursor] === '-';
    if (stripsTabs) cursor += 1;
    while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
    let delimiter = '';
    let expands = true;
    while (cursor < line.length) {
      const delimiterChar = line[cursor]!;
      if (delimiterChar === "'" || delimiterChar === '"') {
        expands = false;
        const closing = line.indexOf(delimiterChar, cursor + 1);
        if (closing < 0) {
          delimiter += line.slice(cursor + 1);
          cursor = line.length;
          break;
        }
        delimiter += line.slice(cursor + 1, closing);
        cursor = closing + 1;
        continue;
      }
      if (delimiterChar === '\\') {
        expands = false;
        cursor += 1;
        if (cursor < line.length) {
          delimiter += line[cursor]!;
          cursor += 1;
        }
        continue;
      }
      if (/[\s;&|<>()]/.test(delimiterChar)) break;
      delimiter += delimiterChar;
      cursor += 1;
    }
    if (delimiter !== '') {
      redirections.push({ marker: line.slice(index, cursor), delimiter, expands, stripsTabs });
    }
    index = cursor - 1;
  }
  return redirections;
}

/** Whether the heredoc's own clause hands its body to a code-reading consumer. */
function heredocBodyIsProgram(line: string, marker: string): boolean {
  const segments = shellSegments(line);
  const openingIndex = segments.findIndex((segment) => segment.command.includes(marker));
  if (openingIndex < 0) return false;
  for (let index = openingIndex; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (index > openingIndex && segment.precedingOperator !== '|') break;
    if (
      consumesStdinAsProgram(
        tokenizeHeredocConsumer(segment.command.replace(marker, ' ')),
      )
    ) return true;
  }
  return false;
}

/**
 * Remove stdin-only heredoc prose before classifying command words.
 *
 * Bodies executed by a shell/interpreter remain visible. Data bodies disappear,
 * except that an unquoted delimiter still executes command/process substitutions.
 */
function stripHeredocBodies(command: string): string {
  if (!command.includes('<<')) return command;
  const lines = command.split(/\r?\n/);
  const executable: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    executable.push(line);
    for (const heredoc of heredocRedirections(line)) {
      const body: string[] = [];
      index += 1;
      for (; index < lines.length; index += 1) {
        const candidate = lines[index]!;
        const unindented = heredoc.stripsTabs ? candidate.replace(/^\t+/, '') : candidate;
        if (unindented === heredoc.delimiter) break;
        body.push(candidate);
      }
      if (heredocBodyIsProgram(line, heredoc.marker)) executable.push(...body);
      else if (heredoc.expands) executable.push(...shellSubcommands(body.join('\n')));
      if (index >= lines.length) break;
    }
  }
  return executable.join('\n');
}

function containsSimulatorRecipe(command: string, depth = 0): boolean {
  if (depth > MAX_RECURSION_DEPTH) return false;
  const executableCommand = stripHeredocBodies(command);
  for (const nested of shellSubcommands(executableCommand)) {
    if (containsSimulatorRecipe(nested, depth + 1)) return true;
  }
  const assignments = new Map<string, string[]>();
  const referencedAssignmentContainsRecipe = (reference: string): boolean => {
    for (const [name, values] of assignments) {
      // The name matched `[A-Za-z_][A-Za-z0-9_]*`, so it carries no regex syntax.
      if (!new RegExp(`\\$\\{?${name}\\b`).test(reference)) continue;
      if (values.some((value) => containsSimulatorRecipe(value, depth + 1))) return true;
    }
    return false;
  };
  for (const segment of shellSegments(executableCommand)) {
    const unwrapped = unwrapCommand(tokenizeShellSegment(segment.command));
    // Shell assignments replace the previous value before the command in this
    // segment runs. A `;`/newline-separated assignment therefore supersedes the
    // previous value, while a conditional, pipeline or background edge can skip
    // it or isolate its scope, so both values remain possible there.
    for (const assignment of unwrapped.assignments) {
      if (assignment.name === '') continue;
      const persistentAssignment =
        assignmentDefinitelyRunsInCurrentScope(segment)
        && unwrapped.tokens.length === 0
        && unwrapped.nestedShell === null;
      if (persistentAssignment) {
        assignments.set(assignment.name, [assignment.value]);
      } else {
        const possibleValues = assignments.get(assignment.name) ?? [];
        possibleValues.push(assignment.value);
        assignments.set(assignment.name, possibleValues);
      }
    }
    if (unwrapped.nestedShell !== null) {
      // `eval "$CMD"` and `sh -c "$CMD"` run a variable this scan cannot resolve.
      if (referencedAssignmentContainsRecipe(unwrapped.nestedShell)) return true;
      if (containsSimulatorRecipe(unwrapped.nestedShell, depth + 1)) return true;
      continue;
    }
    // A variable in the command word position is run as the command itself.
    const commandWord = unwrapped.tokens[0];
    if (commandWord?.includes('$') && referencedAssignmentContainsRecipe(commandWord)) return true;
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
