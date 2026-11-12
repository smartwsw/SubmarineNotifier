// 校验生成的插件仓库能否被 Dalamud 正常读取：
//  1. pluginmaster.json 是数组，必填字段齐全且类型正确；
//  2. DownloadLinkInstall 指向的 zip 真的能下载，且内含 DLL + 清单；
//  3. zip 内清单的 InternalName / AssemblyVersion 与 pluginmaster 一致
//     （不一致时 Dalamud 会显示版本号与安装结果不符）。
//
// 用法：
//   node .tooling/release/verify-repo.mjs --base-url http://127.0.0.1:8901
//   node .tooling/release/verify-repo.mjs --base-url https://raw.githubusercontent.com/<user>/<repo>/main/dist/repo
//
// 需要走 HTTP 代理时加 --proxy http://127.0.0.1:10809：
// Node 的 fetch 不读 HTTP_PROXY / HTTPS_PROXY，加代理只能自己接管连接，这里改用 curl。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const baseUrl = (arg('base-url') ?? '').replace(/\/+$/, '');
if (!baseUrl) {
  console.error('缺少 --base-url');
  process.exit(2);
}

const proxy = arg('proxy');
const workDir = mkdtempSync(join(tmpdir(), 'subrepo-verify-'));
let downloadSeq = 0;

// 统一返回 {ok, status, bytes}，代理与非代理两条路径行为一致
async function download(url) {
  if (!proxy) {
    try {
      const res = await fetch(url);
      return { ok: res.ok, status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
    } catch (error) {
      return { ok: false, status: 0, bytes: Buffer.alloc(0), error: error.cause?.message ?? error.message };
    }
  }
  const out = join(workDir, `dl-${++downloadSeq}`);
  let status;
  try {
    status = Number(
      execFileSync('curl', ['-sSL', '-m', '180', '-x', proxy, '-o', out, '-w', '%{http_code}', url], {
        encoding: 'utf8',
      }).trim(),
    );
  } catch (error) {
    return { ok: false, status: 0, bytes: Buffer.alloc(0), error: error.message };
  }
  const bytes = readFileSync(out);
  return { ok: status >= 200 && status < 300, status, bytes };
}

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures += 1;
};

if (proxy) console.log(`      经代理访问：${proxy}\n`);

const manifest = await download(`${baseUrl}/pluginmaster.json`);
check('pluginmaster.json 可访问', manifest.ok, manifest.error ?? `HTTP ${manifest.status}`);
if (!manifest.ok) process.exit(1);

const master = JSON.parse(manifest.bytes.toString('utf8'));
check('清单是数组（Dalamud 只认数组）', Array.isArray(master), typeof master);
const plugin = master[0];
if (!plugin) {
  console.error('数组为空');
  process.exit(1);
}

for (const field of ['Author', 'Name', 'InternalName', 'Punchline', 'Description', 'AssemblyVersion', 'DalamudApiLevel']) {
  check(`字段 ${field} 存在`, plugin[field] !== undefined && plugin[field] !== '', JSON.stringify(plugin[field]));
}
check('Author 不是占位值', plugin.Author !== plugin.InternalName, plugin.Author);
check('DalamudApiLevel 是整数', Number.isInteger(plugin.DalamudApiLevel), String(plugin.DalamudApiLevel));
check('DownloadLinkInstall 是 http(s) 地址', /^https?:\/\//.test(plugin.DownloadLinkInstall ?? ''), plugin.DownloadLinkInstall);
check(
  'DownloadLinkUpdate 与 Install 指向同一个 zip',
  plugin.DownloadLinkUpdate === plugin.DownloadLinkInstall,
  plugin.DownloadLinkUpdate,
);

// --zip-base 把 DownloadLink 换成同一份文件的另一个前缀，
// 用于在本地 HTTP 服务上验证"清单内容正确"，同时保留生产 URL 的格式校验。
const zipBase = (arg('zip-base') ?? '').replace(/\/+$/, '');
const zipUrl = zipBase
  ? `${zipBase}/${plugin.DownloadLinkInstall.split('/').pop()}`
  : plugin.DownloadLinkInstall;
if (zipBase) console.log(`      下载改用本地前缀：${zipUrl}`);

const zipRes = await download(zipUrl);
check('zip 可下载', zipRes.ok, zipRes.error ?? `HTTP ${zipRes.status}`);
if (!zipRes.ok) process.exit(1);

const bytes = zipRes.bytes;
check('zip 非空', bytes.length > 1024, `${bytes.length} bytes`);

const dir = mkdtempSync(join(tmpdir(), 'subrepo-'));
const zipPath = join(dir, 'plugin.zip');
writeFileSync(zipPath, bytes);

try {
  const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  check('zip 内含主 DLL', listing.includes(`${plugin.InternalName}.dll`));
  check('zip 内含插件清单', listing.includes(`${plugin.InternalName}.json`));

  const innerRaw = execFileSync('unzip', ['-p', zipPath, `${plugin.InternalName}.json`], { encoding: 'utf8' });
  const inner = JSON.parse(innerRaw);
  check('zip 内清单 InternalName 一致', inner.InternalName === plugin.InternalName, inner.InternalName);
  check('zip 内清单 AssemblyVersion 一致', inner.AssemblyVersion === plugin.AssemblyVersion, inner.AssemblyVersion);
  check('zip 内清单 DalamudApiLevel 一致', inner.DalamudApiLevel === plugin.DalamudApiLevel, String(inner.DalamudApiLevel));
  check('zip 内清单 Author 一致', inner.Author === plugin.Author, inner.Author);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// 本地对照：仓库目录里必须真的存在这个 zip
const localZip = join(root, 'dist/repo', plugin.DownloadLinkInstall.split('/').pop() ?? '');
let localExists = false;
try {
  readFileSync(localZip);
  localExists = true;
} catch {
  localExists = false;
}
check('dist/repo 下存在对应 zip', localExists, localZip);

if (proxy) rmSync(workDir, { recursive: true, force: true });

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
