// Claude Usage Bar — % hạn mức Claude Code trên thanh trạng thái + chuyển giữa nhiều tài khoản.
//
// Nhiều tài khoản theo đúng cách Claude Code hướng dẫn (https://code.claude.com/docs/en/authentication):
// mỗi tài khoản một thư mục cấu hình (CLAUDE_CONFIG_DIR) — đăng nhập claude.ai và mục Keychain riêng.
// Tài khoản "Mặc định" là ~/.claude; tài khoản thêm vào nằm ở ~/.claude-accounts/<tên>. Chuyển tài khoản =
// đặt CLAUDE_CONFIG_DIR trong cài đặt claudeCode.environmentVariables (extension Claude Code đọc khi mở
// phiên) và — nếu bật — trong biến môi trường của terminal tích hợp.
// Lịch sử phiên, CLAUDE.md, settings.json, skills, plugins… được dùng chung qua symlink tới ~/.claude.
//
// Số liệu hạn mức: chạy `claude -p` ở chế độ stream-json và gửi yêu cầu điều khiển `get_usage` (như bảng
// Account & Usage của extension Claude) — không gửi prompt nên không tốn hạn mức, không đọc token nào.
// get_usage là API THỬ NGHIỆM của Claude Code: bản sau có thể đổi, khi đó ô báo lỗi.
'use strict';

const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = 30_000;
// Những thứ dùng chung giữa các tài khoản (symlink tới ~/.claude nếu ở đó đã có).
const SHARED = ['CLAUDE.md', 'settings.json', 'keybindings.json', 'projects', 'file-history', 'todos', 'plans',
  'skills', 'agents', 'commands', 'output-styles', 'plugins', 'ide'];
// Phần chép từ ~/.claude.json sang tài khoản mới (MCP, thiết lập theo dự án) — không chép đăng nhập / bộ nhớ đệm.
const COPIED_STATE = ['mcpServers', 'projects', 'autoUpdates', 'autoUpdatesProtectedForNative', 'installMethod'];

let item;
let timer;
let running = null;
const state = new Map(); // id tài khoản → { at, status, usage, error }

const home = () => os.homedir();
const baseDir = () => process.env.CLAUDE_USAGE_ACCOUNTS_DIR || path.join(home(), '.claude-accounts');
const defaultDir = () => path.join(home(), '.claude');
const config = () => vscode.workspace.getConfiguration('claudeUsage');

function activate(context) {
  item = vscode.window.createStatusBarItem('claudeUsage.bar', vscode.StatusBarAlignment.Right, 1000);
  item.name = 'Claude Usage';
  item.command = 'claudeUsage.accounts';
  item.text = '$(sync~spin) Claude';
  item.tooltip = 'Đang lấy hạn mức Claude Code…';
  item.show();

  context.subscriptions.push(
    item,
    vscode.commands.registerCommand('claudeUsage.accounts', showAccounts),
    vscode.commands.registerCommand('claudeUsage.refresh', () => refresh(true)),
    vscode.commands.registerCommand('claudeUsage.addAccount', addAccount),
    vscode.commands.registerCommand('claudeUsage.switchAccount', (id) => (id ? switchTo(findAccount(id)) : showAccounts())),
    vscode.commands.registerCommand('claudeUsage.removeAccount', removeAccount),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeUsage.refreshMinutes')) schedule();
      if (e.affectsConfiguration('claudeCode.environmentVariables')) render();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      const oldest = Math.min(...accounts().map((a) => state.get(a.id)?.at ?? 0));
      if (s.focused && Date.now() - oldest > 120_000) refresh(false);
    }),
    { dispose: () => clearInterval(timer) },
  );
  schedule();
  refresh(false);
}

function schedule() {
  clearInterval(timer);
  const minutes = Math.max(1, Number(config().get('refreshMinutes')) || 5);
  timer = setInterval(() => refresh(false), minutes * 60_000);
}

// --- Danh sách tài khoản ------------------------------------------------------

function registryPath() {
  return path.join(baseDir(), 'accounts.json');
}

function readRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    return Array.isArray(data.accounts) ? data.accounts.filter((a) => a && a.id && a.dir) : [];
  } catch {
    return [];
  }
}

function writeRegistry(list) {
  fs.mkdirSync(baseDir(), { recursive: true });
  const tmp = `${registryPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ accounts: list.map(({ id, label, dir }) => ({ id, label, dir })) }, null, 2)}\n`);
  fs.renameSync(tmp, registryPath());
}

/** Mặc định (~/.claude) + các tài khoản đã thêm. */
function accounts() {
  return [{ id: 'default', label: '', dir: null }, ...readRegistry()];
}

function findAccount(id) {
  return accounts().find((a) => a.id === id);
}

/** CLAUDE_CONFIG_DIR đang đặt cho extension Claude Code (null = mặc định). */
function configuredDir() {
  const vars = envList(vscode.workspace.getConfiguration('claudeCode').get('environmentVariables'));
  const value = vars.find((v) => v.name === 'CLAUDE_CONFIG_DIR')?.value?.trim();
  return value ? path.resolve(value) : null;
}

function activeAccount() {
  const dir = configuredDir();
  if (!dir || dir === path.resolve(defaultDir())) return accounts()[0];
  return accounts().find((a) => a.dir && path.resolve(a.dir) === dir)
    ?? { id: 'custom', label: path.basename(dir), dir, custom: true };
}

/** Giá trị claudeCode.environmentVariables có thể là mảng {name, value} hoặc object — đọc như extension Claude. */
function envList(value) {
  if (Array.isArray(value)) {
    return value.filter((v) => v && typeof v === 'object' && typeof v.name === 'string')
      .map((v) => ({ name: v.name, value: v.value == null ? '' : String(v.value) }));
  }
  if (value && typeof value === 'object') return Object.entries(value).map(([name, v]) => ({ name, value: v == null ? '' : String(v) }));
  return [];
}

function displayName(acc) {
  if (acc.label) return acc.label;
  const email = state.get(acc.id)?.status?.email;
  return email ? email.split('@')[0] : 'Mặc định';
}

// --- Gọi Claude Code ----------------------------------------------------------

function claudeBinary() {
  const custom = String(config().get('claudePath') || '').trim();
  const win = process.platform === 'win32';
  const candidates = [
    custom,
    path.join(home(), '.local', 'bin', win ? 'claude.exe' : 'claude'),
    ...(win ? [] : ['/opt/homebrew/bin/claude', '/usr/local/bin/claude']),
    ...bundledBinaries(),
  ].filter(Boolean);
  return candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || 'claude';
}

/** Bản claude đi kèm extension Claude Code (khi máy không cài CLI riêng). */
function bundledBinaries() {
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (!ext) return [];
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  return [path.join(ext.extensionPath, 'resources', 'native-binary', name)];
}

function envFor(acc) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_CWD;
  if (acc.dir) env.CLAUDE_CONFIG_DIR = acc.dir;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

function run(acc, args, { onLine, input } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(claudeBinary(), args, { cwd: os.tmpdir(), env: envFor(acc), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let out = '';
    let err = '';
    let buf = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { child.stdin.end(); } catch { /* đã đóng */ }
      child.kill();
      fn(value);
    };
    const timeout = setTimeout(() => finish(reject, new Error('Claude Code không trả lời sau 30 giây')), TIMEOUT_MS);
    const api = { send: (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`), resolve: (v) => finish(resolve, v), reject: (e) => finish(reject, e) };

    child.on('error', (e) => finish(reject, new Error(e.code === 'ENOENT'
      ? 'Không tìm thấy lệnh claude — đặt đường dẫn ở cài đặt "claudeUsage.claudePath"'
      : e.message)));
    child.on('close', (code) => (onLine
      ? finish(reject, new Error(`claude thoát (mã ${code})${err ? `: ${err.trim().slice(0, 200)}` : ''}`))
      : finish(resolve, { code, out, err })));
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d;
      if (!onLine) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { onLine(JSON.parse(line), api); } catch { /* dòng không phải JSON */ }
      }
    });
    if (input) api.send(input);
    else if (!onLine) child.stdin.end();
  });
}

async function authStatus(acc) {
  const { out } = await run(acc, ['auth', 'status', '--json']);
  const start = out.indexOf('{');
  if (start < 0) throw new Error('claude auth status không trả JSON');
  return JSON.parse(out.slice(start));
}

function getUsage(acc) {
  return run(acc, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}',
  ], {
    input: { type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } },
    onLine: (msg, api) => {
      if (msg.type !== 'control_response') return;
      const res = msg.response || {};
      if (res.subtype === 'error') api.reject(new Error(res.error || 'Claude Code báo lỗi'));
      else if (res.request_id === 'init') api.send({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage' } });
      else if (res.request_id === 'usage') api.resolve(res.response || {});
    },
  });
}

async function refreshOne(acc) {
  const prev = state.get(acc.id) ?? {};
  try {
    const status = await authStatus(acc);
    const usage = status.loggedIn ? await getUsage(acc) : null;
    state.set(acc.id, { at: Date.now(), status, usage, error: null });
  } catch (err) {
    state.set(acc.id, { ...prev, at: Date.now(), error: String(err.message || err) });
  }
}

function refresh(manual) {
  if (running) return running;
  if (manual) item.text = '$(sync~spin) Claude';
  running = (async () => {
    // Tài khoản đang dùng trước để ô trạng thái có số sớm nhất.
    const active = activeAccount();
    const list = [active, ...accounts().filter((a) => a.id !== active.id)];
    for (const acc of list) {
      await refreshOne(acc);
      render();
    }
  })().finally(() => { running = null; render(); });
  return running;
}

// --- Chuyển / thêm / gỡ tài khoản ---------------------------------------------

async function switchTo(acc, { quiet = false } = {}) {
  if (!acc) return;
  const target = vscode.ConfigurationTarget.Global;
  const cfg = vscode.workspace.getConfiguration('claudeCode');
  const vars = envList(cfg.inspect('environmentVariables')?.globalValue).filter((v) => v.name !== 'CLAUDE_CONFIG_DIR');
  if (acc.dir) vars.push({ name: 'CLAUDE_CONFIG_DIR', value: path.resolve(acc.dir) });
  await cfg.update('environmentVariables', vars, target);

  if (config().get('switchTerminal') !== false) {
    const key = { darwin: 'osx', win32: 'windows' }[process.platform] ?? 'linux';
    const tcfg = vscode.workspace.getConfiguration('terminal.integrated.env');
    const env = { ...(tcfg.inspect(key)?.globalValue ?? {}) };
    if (acc.dir) env.CLAUDE_CONFIG_DIR = path.resolve(acc.dir);
    else delete env.CLAUDE_CONFIG_DIR;
    await tcfg.update(key, Object.keys(env).length ? env : undefined, target);
  }
  render();
  if (quiet) return;
  const pick = await vscode.window.showInformationMessage(
    `Đã chuyển Claude Code sang ${displayName(acc)}. Phiên chat đang mở vẫn dùng tài khoản cũ — tải lại cửa sổ để mọi phiên dùng tài khoản mới (lịch sử chat vẫn giữ).`,
    'Tải lại cửa sổ',
  );
  if (pick) vscode.commands.executeCommand('workbench.action.reloadWindow');
}

function slugify(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** Thư mục cấu hình cho tài khoản mới: symlink phần dùng chung, chép phần cấu hình không chứa đăng nhập. */
function prepareDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of SHARED) {
    const src = path.join(defaultDir(), name);
    const dst = path.join(dir, name);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      // Windows: thư mục dùng junction (không cần quyền admin); tệp lẻ cần Developer Mode, không được thì bỏ qua.
      const type = process.platform === 'win32' && fs.statSync(src).isDirectory() ? 'junction' : undefined;
      try { fs.symlinkSync(src, dst, type); } catch { /* bỏ qua: tài khoản này dùng bản riêng */ }
    }
  }
  const stateFile = path.join(dir, '.claude.json');
  if (!fs.existsSync(stateFile)) {
    try {
      const main = JSON.parse(fs.readFileSync(path.join(home(), '.claude.json'), 'utf8'));
      const copy = Object.fromEntries(COPIED_STATE.filter((k) => k in main).map((k) => [k, main[k]]));
      fs.writeFileSync(stateFile, `${JSON.stringify(copy, null, 2)}\n`, { mode: 0o600 });
    } catch { /* chưa có ~/.claude.json: Claude Code tự tạo */ }
  }
}

function openLogin(acc) {
  const terminal = vscode.window.createTerminal({
    name: `Claude: đăng nhập ${displayName(acc)}`,
    shellPath: claudeBinary(),
    shellArgs: ['auth', 'login'],
    env: { CLAUDE_CONFIG_DIR: acc.dir ?? defaultDir() },
    iconPath: new vscode.ThemeIcon('account'),
  });
  terminal.show();
  vscode.window.showInformationMessage(
    `Đăng nhập "${displayName(acc)}" trong trình duyệt vừa mở. Trình duyệt đang đăng nhập claude.ai bằng tài khoản khác thì đổi tài khoản trên claude.ai trước (hoặc dùng cửa sổ ẩn danh: bấm c trong terminal để chép link).`,
  );
  const sub = vscode.window.onDidCloseTerminal(async (closed) => {
    if (closed !== terminal) return;
    sub.dispose();
    await refreshOne(acc);
    render();
    const st = state.get(acc.id)?.status;
    if (!st?.loggedIn) {
      vscode.window.showWarningMessage(`"${displayName(acc)}" chưa đăng nhập. Mở danh sách tài khoản và chọn nó để đăng nhập lại.`);
      return;
    }
    const twin = accounts().find((a) => a.id !== acc.id && state.get(a.id)?.status?.email === st.email);
    if (twin) {
      vscode.window.showWarningMessage(`"${displayName(acc)}" đang đăng nhập cùng email với "${displayName(twin)}" (${st.email}). Đổi tài khoản trên claude.ai rồi đăng nhập lại nếu muốn tài khoản khác.`);
    } else {
      const pick = await vscode.window.showInformationMessage(`Đã kết nối ${st.email}.`, 'Chuyển sang tài khoản này');
      if (pick) switchTo(acc);
    }
  });
}

async function addAccount() {
  const taken = new Set(accounts().map((a) => a.id));
  const label = await vscode.window.showInputBox({
    title: 'Thêm tài khoản Claude Code',
    prompt: 'Tên gợi nhớ cho tài khoản (vd: cong-ty, ca-nhan). Sau đó trình duyệt mở để đăng nhập.',
    validateInput: (v) => {
      const id = slugify(v);
      if (!id) return 'Nhập tên có chữ hoặc số';
      if (taken.has(id)) return 'Tên này đã dùng';
      return null;
    },
  });
  if (!label) return;
  const id = slugify(label);
  const acc = { id, label: label.trim(), dir: path.join(baseDir(), id) };
  try {
    prepareDir(acc.dir);
    writeRegistry([...readRegistry(), acc]);
  } catch (err) {
    vscode.window.showErrorMessage(`Không tạo được thư mục tài khoản: ${err.message}`);
    return;
  }
  render();
  openLogin(acc);
}

async function removeAccount() {
  const list = readRegistry();
  if (!list.length) {
    vscode.window.showInformationMessage('Chưa có tài khoản nào được thêm (tài khoản Mặc định không gỡ ở đây).');
    return;
  }
  const pick = await vscode.window.showQuickPick(list.map((a) => ({
    label: displayName(a), description: state.get(a.id)?.status?.email ?? '', acc: a,
  })), { title: 'Gỡ tài khoản Claude Code' });
  if (!pick) return;
  const ok = await vscode.window.showWarningMessage(
    `Gỡ "${pick.label}"? Tài khoản này sẽ bị đăng xuất khỏi máy. Lịch sử chat dùng chung không bị ảnh hưởng.`,
    { modal: true }, 'Gỡ',
  );
  if (ok !== 'Gỡ') return;
  if (activeAccount().id === pick.acc.id) await switchTo(accounts()[0], { quiet: true });
  // Chỉ đăng xuất khi chắc lệnh đang trỏ đúng thư mục của tài khoản này — không bao giờ đụng tài khoản khác.
  try {
    const st = await authStatus(pick.acc);
    if (st.configDirectory && path.resolve(st.configDirectory) === path.resolve(pick.acc.dir)) await run(pick.acc, ['auth', 'logout']);
  } catch { /* đã đăng xuất / không gọi được: bỏ qua */ }
  writeRegistry(readRegistry().filter((a) => a.id !== pick.acc.id));
  state.delete(pick.acc.id);
  render();
  vscode.window.showInformationMessage(`Đã gỡ "${pick.label}". Thư mục ${pick.acc.dir} vẫn giữ lại — xoá tay nếu không cần.`);
}

async function showAccounts() {
  const active = activeAccount();
  const list = accounts();
  if (active.custom) list.push(active);
  const qp = vscode.window.createQuickPick();
  qp.title = 'Tài khoản Claude Code';
  qp.placeholder = 'Chọn tài khoản để chuyển sang';
  qp.matchOnDescription = true;
  const build = () => {
    qp.items = [
      ...list.map((acc) => {
        const s = state.get(acc.id);
        const isActive = acc.id === active.id;
        return {
          label: `${isActive ? '$(check)' : '$(account)'} ${displayName(acc)}`,
          description: [s?.status?.email, isActive ? 'đang dùng' : ''].filter(Boolean).join(' · '),
          detail: summary(acc),
          acc,
        };
      }),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(add) Thêm tài khoản…', action: 'add' },
      { label: '$(sync) Làm mới hạn mức', action: 'refresh' },
      ...(readRegistry().length ? [{ label: '$(trash) Gỡ tài khoản…', action: 'remove' }] : []),
    ];
  };
  build();
  qp.onDidAccept(() => {
    const sel = qp.selectedItems[0];
    if (!sel) return;
    if (sel.action === 'refresh') {
      qp.busy = true;
      refresh(true).then(() => { qp.busy = false; build(); });
      return;
    }
    qp.hide();
    if (sel.action === 'add') addAccount();
    else if (sel.action === 'remove') removeAccount();
    else if (sel.acc) {
      const s = state.get(sel.acc.id);
      if (s && s.status && !s.status.loggedIn) openLogin(sel.acc);
      else if (sel.acc.id !== active.id) switchTo(sel.acc);
    }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

// --- Hiển thị -----------------------------------------------------------------

/** Danh sách hạn mức: ưu tiên `limits` (như bảng Account & Usage), không có thì đọc rate_limits. */
function limitsOf(data) {
  if (Array.isArray(data?.rate_limits?.limits)) {
    return data.rate_limits.limits
      .filter((l) => typeof l.percent === 'number')
      .map((l) => ({
        label: labelOf(l),
        short: l.scope ? null : shortOf(l.group || l.kind),
        percent: l.percent,
        severity: l.severity,
        resetsAt: l.resets_at,
      }));
  }
  const out = [];
  for (const [key, short, label] of [['five_hour', '5h', '5 giờ'], ['seven_day', '7d', 'Tuần']]) {
    const w = data?.rate_limits?.[key];
    if (w && typeof w.utilization === 'number') out.push({ label, short, percent: w.utilization, resetsAt: w.resets_at });
  }
  return out;
}

function labelOf(l) {
  const model = l.scope?.model?.display_name;
  const base = { weekly: 'Tuần', session: '5 giờ', five_hour: '5 giờ', daily: 'Ngày', monthly: 'Tháng' }[l.group] || l.group || l.kind;
  return model ? `${base} — ${model}` : base;
}

function shortOf(group) {
  return { weekly: '7d', session: '5h', five_hour: '5h', daily: '1d', monthly: '1m' }[group] || group;
}

/** Một dòng tóm tắt hạn mức của tài khoản (dùng trong danh sách chọn). */
function summary(acc) {
  const s = state.get(acc.id);
  if (!s) return 'Đang lấy hạn mức…';
  if (s.status && !s.status.loggedIn) return '$(circle-slash) Chưa đăng nhập — chọn để đăng nhập';
  const limits = limitsOf(s.usage);
  const text = limits.map((l) => `${l.label} ${fmt(l.percent)}`).join(' · ');
  const reset = limits.find((l) => l.short)?.resetsAt;
  return [text || (s.error ? '' : 'Chưa có số liệu'), reset ? `reset ${when(reset)}` : '', s.error ? `$(warning) ${s.error}` : '']
    .filter(Boolean).join(' · ');
}

function render() {
  if (!item) return;
  const active = activeAccount();
  const s = state.get(active.id);
  const limits = limitsOf(s?.usage);
  const main = limits.filter((l) => l.short);
  const worst = Math.max(0, ...limits.map((l) => l.percent));
  const many = accounts().length > 1 || active.custom;
  const name = many ? `${displayName(active)} · ` : 'Claude ';

  if (s?.status && !s.status.loggedIn) {
    item.text = `$(circle-slash) ${many ? displayName(active) : 'Claude'} chưa đăng nhập`;
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else if (!limits.length) {
    item.text = s?.error ? `$(warning) ${name}?` : `$(sync~spin) ${name.trim()}`;
    item.backgroundColor = undefined;
  } else {
    const parts = (main.length ? main : limits.slice(0, 1)).map((l) => (main.length > 1 ? `${l.short} ${fmt(l.percent)}` : fmt(l.percent)));
    item.text = `${many ? '$(account)' : '$(pulse)'} ${name}${parts.join(' · ')}${s?.error ? ' $(warning)' : ''}`;
    const sev = limits.map((l) => l.severity).join(' ');
    item.backgroundColor = worst >= 95 || /critical|exceeded|blocked/.test(sev)
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : worst >= 80 || /warning/.test(sev) ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  const md = new vscode.MarkdownString('', true);
  md.isTrusted = { enabledCommands: ['claudeUsage.accounts', 'claudeUsage.refresh', 'claudeUsage.addAccount', 'claude-vscode.focus'] };
  md.appendMarkdown('**Hạn mức Claude Code**\n\n');
  const list = accounts();
  if (active.custom) list.push(active);
  for (const acc of list) {
    const st = state.get(acc.id);
    const head = `${acc.id === active.id ? '$(check) ' : ''}**${escape(displayName(acc))}**${st?.status?.email ? ` · ${escape(st.status.email)}` : ''}`;
    md.appendMarkdown(`${head}\n\n`);
    if (st?.status && !st.status.loggedIn) md.appendMarkdown('- chưa đăng nhập\n');
    for (const l of limitsOf(st?.usage)) {
      md.appendMarkdown(`- ${escape(l.label)}: **${fmt(l.percent)}** ${bar(l.percent)}${l.resetsAt ? ` — reset ${when(l.resetsAt)} (${countdown(l.resetsAt)})` : ''}\n`);
    }
    if (!st) md.appendMarkdown('- đang lấy…\n');
    if (st?.error) md.appendMarkdown(`- $(warning) ${escape(st.error)}\n`);
    md.appendMarkdown('\n');
  }
  const at = Math.max(0, ...list.map((a) => state.get(a.id)?.at ?? 0));
  md.appendMarkdown(`Cập nhật ${at ? new Date(at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '—'}`
    + ' · [Đổi tài khoản](command:claudeUsage.accounts) · [Thêm](command:claudeUsage.addAccount)'
    + ' · [Làm mới](command:claudeUsage.refresh) · [Mở chat Claude Code](command:claude-vscode.focus)');
  item.tooltip = md;
}

const fmt = (p) => `${Math.round(p)}%`;

function bar(p) {
  const n = Math.max(0, Math.min(10, Math.round(p / 10)));
  return `\`${'█'.repeat(n)}${'░'.repeat(10 - n)}\``;
}

function when(value) {
  const d = new Date(typeof value === 'number' ? value * 1000 : value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Đếm ngược theo ngày tới lúc reset, ví dụ "còn 2 ngày", "còn 0 ngày" (dưới 24 giờ). */
function countdown(value) {
  const d = new Date(typeof value === 'number' ? value * 1000 : value);
  const ms = d.getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  const days = Math.max(0, Math.floor(ms / 86400000));
  return `còn ${days} ngày`;
}

const escape = (s) => String(s).replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');

function deactivate() {
  clearInterval(timer);
}

module.exports = { activate, deactivate, limitsOf, render, prepareDir, switchTo, activeAccount, accounts, slugify, state };
