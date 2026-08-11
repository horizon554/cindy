import { describe, expect, it } from 'vitest';
import { getDesktopShellCommandPolicy } from '../shell-command-policy.js';

const describeMac = process.platform === 'darwin' ? describe : describe.skip;

describeMac('embedded iOS Simulator shell policy', () => {
  it.each([
    'open -a Simulator',
    'open -n -a "Simulator.app"',
    'open -na Simulator',
    'open -b com.apple.iphonesimulator',
    'open /Applications/Xcode.app/Contents/Developer/Applications/Simulator.app',
    '/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator',
  ])('denies an external Simulator launch: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
  });

  it('denies a multiline legacy simulator workflow before it can execute', () => {
    const command = [
      'SIM_UUID=1A9D41E0-E031-4AD0-A8B5-847480802E8E',
      'xcrun simctl boot "$SIM_UUID"',
      'open -a Simulator',
      'xcrun simctl install "$SIM_UUID" /tmp/FiloApp.app',
    ].join('\n');
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('cindy_ios_simulator'),
    });
  });

  it.each([
    'xcrun simctl boot DEVICE',
    'xcrun simctl bootstatus DEVICE -b',
    'xcrun simctl install DEVICE /tmp/App.app',
    'xcrun simctl launch DEVICE com.example.app',
    'xcrun simctl shutdown DEVICE',
    '/usr/bin/xcrun simctl io DEVICE screenshot /tmp/frame.png',
  ])('denies direct Simulator mutation: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
  });

  it.each([
    'exec /usr/bin/xcrun simctl shutdown DEVICE',
    'command -p xcrun simctl boot DEVICE',
    'builtin exec xcrun simctl install DEVICE /tmp/App.app',
    'nohup -- xcrun simctl launch DEVICE com.example.app',
    'env FOO=1 /usr/bin/xcrun simctl shutdown DEVICE',
    'FOO=1 exec env BAR=2 xcrun simctl boot DEVICE',
    "bash -lc 'xcrun simctl shutdown DEVICE'",
    "/bin/csh -c 'xcrun simctl shutdown DEVICE'",
    "/bin/tcsh -c 'xcrun simctl shutdown DEVICE'",
    "/bin/ksh -c 'xcrun simctl shutdown DEVICE'",
    "fish -c 'xcrun simctl shutdown DEVICE'",
    "eval 'xcrun simctl erase DEVICE'",
    'echo "$(xcrun simctl shutdown DEVICE)"',
    'echo >(xcrun simctl shutdown DEVICE)',
    "env -S 'xcrun simctl shutdown DEVICE'",
    'CMD=xcrun\\ simctl\\ shutdown\\ DEVICE; eval "$CMD"',
    'CMD=xcrun\\ simctl\\ shutdown\\ DEVICE; sh -c "$CMD"',
    'CMD=xcrun\\ simctl\\ shutdown\\ DEVICE; $CMD',
    'printf "xcrun simctl shutdown DEVICE\\n" | sh',
    'time xcrun simctl shutdown DEVICE',
    'time -p xcrun simctl boot DEVICE',
    'f(){ xcrun simctl shutdown DEVICE;}; f',
    'f() ( xcrun simctl shutdown DEVICE ); f',
    `function f () ( printf '%s' "$(date)"; /usr/bin/open -a Simulator ); f`,
    '/usr/bin/xcrun \\\n simctl shutdown DEVICE',
    '/usr/bin/nice /usr/bin/xcrun simctl erase DEVICE',
    '/usr/bin/arch -arm64 /usr/bin/xcrun simctl boot DEVICE',
    '/usr/bin/caffeinate -i /usr/bin/xcrun simctl shutdown DEVICE',
    `/bin/sh -c '"$0" "$@"' /usr/bin/xcrun simctl shutdown DEVICE`,
    `/bin/sh -c '/usr/bin/open -a "$1"' ignored Simulator`,
    '$(/usr/bin/xcrun --find simctl) shutdown DEVICE',
    '/usr/bin/xc[r]un simctl shutdown DEVICE',
    'TOOL=simctl; /usr/bin/xcrun "$TOOL" shutdown DEVICE',
    'A=sim; B=ctl; xcrun "$A$B" shutdown DEVICE',
    'A=sim; B=ctl; xcrun --sdk iphonesimulator "${A}${B}" erase DEVICE',
    'xcrun s{imc,foo}tl shutdown DEVICE',
    'A="default simctl"; xcrun --toolchain ${=A} shutdown DEVICE',
    `bash -lc 'A="default simctl"; xcrun --toolchain $A shutdown DEVICE'`,
    'A=(default simctl); xcrun --toolchain "${(@)A}" shutdown DEVICE',
    'A="default simctl"; xcrun --toolchain "$=A" shutdown DEVICE',
    'A=(default simctl); xcrun --toolchain "$A[@]" shutdown DEVICE',
    `bash -O extglob -lc 'xcrun @(simctl) shutdown DEVICE'`,
    `zsh -o extendedglob -c 'xcrun ^foo shutdown DEVICE'`,
    'xcrun --sdk "$SDK" simctl list devices',
    'A=default; xcrun --toolchain "$A" swift --version',
    'xargs /usr/bin/xcrun simctl shutdown DEVICE',
    "find . -maxdepth 0 -exec /usr/bin/xcrun simctl shutdown DEVICE ';'",
    `printf 'simctl shutdown DEVICE' | xargs /usr/bin/xcrun`,
    'xcrun "$(printf simctl)" shutdown DEVICE',
    'xcrun $(printf simctl) shutdown DEVICE',
    'xcrun $(echo simctl) shutdown DEVICE',
    'TOOL=$(printf simctl); xcrun "$TOOL" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=simctl; env "$A$B" "$C" shutdown DEVICE',
    'A=x; B=crun; C=sim; D=ctl; command "${A}${B}" "${C}${D}" shutdown DEVICE',
    '$(printf xcr)$(printf un) simctl shutdown DEVICE',
    'x{cr,foo}un simctl shutdown DEVICE',
    'RUNNER="$UNTRUSTED_EXECUTABLE"; exec "$RUNNER" --version',
    'env -S "$UNTRUSTED_EXECUTABLE"',
    'A=xcr; B=un; C=sim; D=ctl; CMD="$A$B $C$D shutdown DEVICE"; env -S "$CMD"',
    'time -l "$UNTRUSTED_EXECUTABLE"',
    'xargs "$UNTRUSTED_EXECUTABLE"',
    "find . -maxdepth 0 -exec \"$UNTRUSTED_EXECUTABLE\" '{}' '+'",
    `sandbox-exec -p '(version 1) (allow default)' "$UNTRUSTED_EXECUTABLE"`,
    'A=xcr; B=un; sh -c \'"$0" simctl shutdown DEVICE\' "$A$B"',
    'A=xcr; B=un; C=sim; D=ctl; >/tmp/cindy-shell.log "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; 2>/dev/null "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; < /dev/null "$A$B" "$C$D" shutdown DEVICE',
    "A=xcr; B=un; C=sim; D=ctl; COUNT='arr[$($A$B $C$D shutdown DEVICE)]'; (( COUNT ))",
    "A=xcr; B=un; C=sim; D=ctl; PAYLOAD='arr[$($A$B $C$D shutdown DEVICE)]'; COUNT=PAYLOAD; (( COUNT ))",
    "A=xcr; B=un; C=sim; D=ctl; printf -v COUNT 'arr[$($A$B $C$D shutdown DEVICE)]'; (( COUNT ))",
    "A=xcr B=un C=sim D=ctl COUNT='arr[$($A$B $C$D shutdown DEVICE)]' bash -c '(( COUNT ))'",
    'xargs -0 /Applications/Xcode.app/Contents/Developer/usr/bin/simct? shutdown DEVICE',
    'sudo -n /Applications/Xcode.app/Contents/Developer/usr/bin/simct[l] shutdown DEVICE',
    'gtimeout -v 5 /Applications/Xcode.app/Contents/Developer/usr/bin/simct? shutdown DEVICE',
    `zsh -o extendedglob -c '/Applications/Xcode.app/Contents/Developer/usr/bin/simct^foo shutdown DEVICE'`,
    `zsh -o extendedglob -c '/Applications/Xcode.app/Contents/Developer/usr/bin/simctl~foo shutdown DEVICE'`,
    `zsh -o extendedglob -c '/Applications/Xcode.app/Contents/Developer/usr/bin/simctl# shutdown DEVICE'`,
    'A=xcr; B=un; C=sim; D=ctl; launchctl asuser 501 "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; launchctl bsexec 123 "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; noglob "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; nocorrect "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; coproc "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; repeat 1 "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; sudo >/dev/null "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; xargs 2>/dev/null "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; launchctl submit -l test >/dev/null -- "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; sudo FOO=bar "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; xargs env FOO=bar "$A$B" "$C$D" shutdown DEVICE',
    'A=xcr; B=un; C=sim; D=ctl; find . -maxdepth 0 -exec env FOO=bar "$A$B" "$C$D" shutdown DEVICE \';\'',
    'A=xcr; B=un; C=sim; D=ctl; sudo command "$A$B" "$C$D" shutdown DEVICE',
    'launchctl submit -l cindy-test -- /usr/bin/xcrun simctl shutdown DEVICE',
    `sandbox-exec -p '(version 1) (allow default)' /usr/bin/xcrun simctl shutdown DEVICE`,
    "shopt -s expand_aliases\nalias sim='xcrun simctl'\nsim shutdown DEVICE",
    "alias sim=xcrun\\ simctl; eval 'sim erase DEVICE'",
    "builtin alias sim='/usr/bin/xcrun simctl'; eval 'sim shutdown DEVICE'",
    "command -- alias sim='open -a Simulator'; eval sim",
    "alias safe='ls -la' sim='xcrun simctl'; eval 'sim boot DEVICE'",
    "alias sc='simctl'; eval 'sc shutdown DEVICE'",
  ])('denies Simulator mutation hidden behind shell execution: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
  });

  it.each(['(( $COUNT > 0 ))', '(( COUNT[$idx]++ ))', 'if (( $COUNT > 0 )); then echo ready; fi'])(
    'denies dynamic shell arithmetic that can recursively execute stored payloads: %s',
    (command) => {
      expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
    },
  );

  it.each([
    `python3 -c 'import subprocess; subprocess.run(["/usr/bin/xcrun", "simctl", "shutdown", "DEVICE"])'`,
    `node -e 'require("node:child_process").execFileSync("xcrun", ["simctl", "erase", "DEVICE"])'`,
    `ruby -e 'system("xcrun simctl boot DEVICE")'`,
    `perl -e 'system("simctl shutdown DEVICE")'`,
    `env FOO=1 python3.12 -c 'import os; os.system("xcrun simctl install DEVICE /tmp/App.app")'`,
    `/usr/bin/python3 -c 'import os; os.system("simctl shutdown DEVICE")'`,
    `awk 'BEGIN { system("xcrun simctl erase DEVICE") }'`,
    `osascript -e 'do shell script "/usr/bin/xcrun simctl shutdown DEVICE"'`,
    `osascript -e 'do shell script "open -a Simulator"'`,
    `printf '%s' 'import os; os.system("xcrun simctl shutdown DEVICE")' | python3`,
    `python3 <<'PY'
import os
os.system("xcrun simctl shutdown DEVICE")
PY`,
    `osascript -e 'set cmd to "/usr/bin/xcrun simctl shutdown DEVICE"' -e 'do shell script cmd'`,
    `osascript -l JavaScript -e 'ObjC.import("Foundation"); const task = $.NSTask.alloc.init; task.launchPath = "/usr/bin/xcrun"; task.arguments = ["simctl", "shutdown", "DEVICE"]; task.launch'`,
    `python3 -c 'import subprocess; subprocess.run(["/usr/bin/open","-a","Simulator"])'`,
    `node -e 'require("child_process").spawnSync("/usr/bin/open",["-na","Simulator"])'`,
    `ruby -e 'system("/usr/bin/open", "-a", "Simulator")'`,
    `/usr/bin/expect -c 'spawn /usr/bin/xcrun simctl shutdown DEVICE; expect eof'`,
    `printf '%s' 'exec /usr/bin/xcrun simctl shutdown DEVICE' | /usr/bin/tclsh`,
    `printf '%s' 'import os; os.system("xcrun simctl shutdown DEVICE")' |& python3`,
    `bash <<< 'xcrun simctl shutdown DEVICE'`,
    `zsh <<< 'open -a Simulator'`,
    `bash -c 'source /dev/stdin' <<< 'xcrun simctl shutdown DEVICE'`,
    `bash -c 'eval "$(cat)"' <<< 'xcrun simctl shutdown DEVICE'`,
    `printf 'xcrun simctl shutdown DEVICE' | bash -c 'eval "$(cat)"'`,
  ])('denies Simulator mutation hidden behind a programmable interpreter: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
  });

  it.each([
    'xcrun simctl list devices',
    'xcrun simctl listapps DEVICE',
    'xcrun simctl list "$DEVICE"',
    'xcrun simctl getenv "$DEVICE" HOME',
    'xcrun --sdk iphonesimulator simctl list devices',
    'xcrun swift --version',
    'exec xcrun simctl list devices',
    'command -p xcrun simctl listapps DEVICE',
    "bash -lc 'xcrun simctl list devices'",
    'f(){ xcrun simctl list devices;}; f',
    'f() ( xcrun simctl list devices ); f',
    'echo "f() ( xcrun simctl shutdown DEVICE )"',
    'command -v xcrun',
    'xcodebuild -scheme FiloApp -sdk iphonesimulator build',
    'open -a Xcode',
    'echo "open -a Simulator"',
    'osascript -e \'tell application "Simulator" to quit\'',
    `python3 -c 'print("ordinary project build")'`,
    `python3 -c 'print("Simulator")'`,
    `node -e 'console.log("ordinary project build")'`,
    'swift test --filter IOSSimulatorTests',
    'swift build --product IOSSimulatorRuntime',
    'find . -maxdepth 1 -name simctl',
    'git grep simctl',
    'git log --grep=simctl',
    `sed -n '/simctl/p' README.md`,
    `jq '.simctl' config.json`,
    'diff simctl-before.txt simctl-after.txt',
    'cp simctl-notes.txt backup.txt',
    'git grep simctl && python3 scripts/check.py',
    'git grep simctl | python3 formatter.py',
    `git grep simctl | awk '{print $1}'`,
    `python3 -c 'print("ordinary")'; git grep simctl`,
    'git grep simctl || python3',
    'alias',
    'alias sim',
    "alias ll='ls -la'; ll",
    'echo "alias sim=\'xcrun simctl\'"',
    'echo "$UNTRUSTED_EXECUTABLE"',
    '# ordinary shell comment',
    '#!/bin/sh\necho ordinary',
    'command -v "$UNTRUSTED_EXECUTABLE"',
    '[ -n "$UNTRUSTED_EXECUTABLE" ]',
    '[[ -n "$UNTRUSTED_EXECUTABLE" ]]',
    '(( 1 + 2 > 0 ))',
    'if (( 3 > 0 )); then echo ready; fi',
    'sudo ls "$ORDINARY_PATH"',
    'sudo -u "$ORDINARY_USER" /bin/echo ok',
    'sudo FOO=bar /bin/echo "$ORDINARY_VALUE"',
    'sudo >/dev/null /bin/echo "$ORDINARY_VALUE"',
    'xargs echo "$ORDINARY_VALUE"',
    'xargs -n "$ORDINARY_COUNT" /bin/echo ok',
    `sandbox-exec -p '(version 1) (allow default)' /bin/echo "$ORDINARY_VALUE"`,
    'sandbox-exec -p "$ORDINARY_PROFILE" /bin/echo ok',
    'launchctl submit -l "$ORDINARY_LABEL" -- /bin/echo ok',
    'launchctl asuser "$ORDINARY_UID" /bin/echo ok',
    'launchctl bsexec "$ORDINARY_PID" /bin/echo "$ORDINARY_VALUE"',
    'watch -d /bin/echo "$ORDINARY_VALUE"',
    'time -l /bin/echo "$ORDINARY_VALUE"',
    'script -q /tmp/typescript /bin/echo "$ORDINARY_VALUE"',
  ])('allows a non-bypass command: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toBeUndefined();
  });

  // A heredoc body, an inline interpreter program and an arithmetic expression
  // are not shell argv. Classifying their contents as command words denied
  // ordinary work with no Simulator executor anywhere in the command.
  it.each([
    // Ordinary HTTPS read through a Python heredoc (issue #2404).
    `python3 - <<'PY'
import urllib.request
data = urllib.request.urlopen("https://example.com").read()
print(len(data))
PY`,
    `python3 - <<'PY'
print(1)
PY`,
    `python3 - <<'PY'
def main():
    print("hi")
main()
PY`,
    `node <<'JS'
console.log(1)
JS`,
    `sqlite3 /tmp/app.db <<'SQL'
SELECT count(*) FROM items;
SQL`,
    `jq . <<'JSON'
{"a": 1}
JSON`,
    `cat > /tmp/notes.txt <<'EOF'
hello (world)
EOF`,
    `node -e "
function check() {
  console.log(1);
}
check();
"`,
    `python3 -c "
def check():
    print(1)
check()
"`,
  ])('allows an ordinary interpreter heredoc or inline program: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toBeUndefined();
  });

  it.each([
    'n=3; (( n > 1 )) && echo yes',
    'i=0; (( i++ )); echo "$i"',
    '(( $# > 0 )) && echo has-args',
    '(( $? == 0 )) && echo ok',
    'i=0; while (( i < 3 )); do echo "$i"; i=$((i+1)); done',
    'if (( count > 0 )); then echo ready; fi',
  ])('allows shell arithmetic with no Simulator evidence: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toBeUndefined();
  });

  it.each([
    'echo start\n*.ts\necho done',
    // A redirected group leaves `}` in command position, which is a shell
    // control token, not a glob-expanded executable name.
    '{ echo a; echo b; } > /tmp/out.log 2>&1',
    '{ pnpm build; pnpm test; } 2>&1 | tee /tmp/build.log',
    '( cd /tmp && ls ) > /tmp/out.txt',
    'expected=200; actual=$(curl -s -o /dev/null -w \'%{http_code}\' https://example.com); if [ "$expected" != "$actual" ]; then echo bad; fi',
    'rg -n "Rejected\\((.*)\\)" apps',
    "rg -n foo --glob '*.{ts,tsx}' apps",
    'grep -rEn "(foo|bar)" apps',
    "awk '{print $1}' /tmp/app.log",
  ])('allows an ordinary command whose shape is not an executable: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toBeUndefined();
  });

  // Evidence matching undoes the concatenation an interpreter would perform, so
  // narrowing the shape-only rules above does not open a fragment bypass.
  it.each([
    `python3 -c 'import os; os.system("xcr" + "un" + " sim" + "ctl shutdown DEVICE")'`,
    `node -e 'require("child_process").execSync("xcr" + "un" + " sim" + "ctl shutdown DEVICE")'`,
    `python3 - <<'PY'
import os
os.system("xcr" + "un" + " sim" + "ctl shutdown DEVICE")
PY`,
    `bash <<'SH'
xcr"un" sim"ctl" shutdown DEVICE
SH`,
    `awk 'BEGIN { system("xcr" "un" " sim" "ctl shutdown DEVICE") }'`,
  ])('denies a Simulator executor assembled from string fragments: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
  });

  // Only the basename selects the executable, and a literal fragment of an
  // executor name can be completed by the expansion next to it. Both stay
  // fail-closed even though no whole Simulator word appears.
  it.each([
    'xcr$TAIL boot DEVICE',
    'sim$TAIL shutdown DEVICE',
    'xc$TAIL boot DEVICE',
    '${DIR}crun boot DEVICE',
    'simct$TAIL shutdown DEVICE',
    'sim* shutdown DEVICE',
    '$DIR/build/$NAME --version',
    '"$PWD/build/$NAME" --version',
    '$DIR/simctl/$SUB shutdown DEVICE',
    // A substitution can supply characters in the middle of the name, and the
    // tokenizer splits on the whitespace inside it, so the command word arrives
    // as an unterminated remnant. Contiguity is not a safe test here.
    'si$(printf m)ctl shutdown DEVICE',
    'sim$(printf c)tl shutdown DEVICE',
    'x$(printf c)run simctl shutdown DEVICE',
    'sim`printf c`tl shutdown DEVICE',
  ])('denies a command word whose executable name cannot be resolved: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
  });

  // Interpreters join sequences as well as concatenating with an operator.
  // This is a finite set of forms by construction: a payload can still assemble
  // a name from character codes or base64, which command text cannot decide.
  it.each([
    `python3 - <<'PY'
import os
os.system(''.join(('xc','run')) + ' ' + ''.join(('sim','ctl')) + ' shutdown DEVICE')
PY`,
    `python3 -c "import os; os.system(''.join(['xc','run']) + ' simctl shutdown DEVICE')"`,
  ])('denies an executor joined from a sequence of fragments: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
  });

  // The deliberate boundary of the narrowing: the executable name is knowable
  // and is not a Simulator executor, so denying it would be a guess about the
  // expansion rather than a product rule. Documented in the PR description.
  it.each([
    '$DIR/build/tool --version',
    'tool$SUFFIX --version',
    'build$SUFFIX --version',
  ])('allows a resolvable non-Simulator executable name: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toBeUndefined();
  });
});
