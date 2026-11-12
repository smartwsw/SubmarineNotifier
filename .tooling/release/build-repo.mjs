// 把 Release 产物打包成第三方插件仓库（可在 Dalamud「自定义插件仓库」里直接添加）。
//
// 产物目录（默认 dist/repo/）：
//   pluginmaster.json                     仓库清单，Dalamud 只认这个文件名
//   SubmarineReturnNotifier-<version>.zip 每个版本一份，不覆盖旧文件
//
// 用法：
//   node .tooling/release/build-repo.mjs \
//     --base-url https://raw.githubusercontent.com/<你>/<仓库>/main/dist/repo \
//     --version 1.0.1.0
//
//   --base-url  必填。zip 的公网前缀，脚本拼成 DownloadLinkInstall/Update。
//   --version   可选。省略时用清单里的 AssemblyVersion。
//   --repo-url  可选。写进 pluginmaster 与清单的 RepoUrl。
//   --out       输出目录，默认 dist/repo。
//   --skip-build 不重新构建，直接复用已有的 latest.zip。
//
// 注意：Dalamud 判断"有新版本"靠 pluginmaster 里的 AssemblyVersion，
// 所以每次发版都必须同时更新清单里的 AssemblyVersion 和这里的 --version。
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const projectDir = join(root, 'plugin/SubmarineReturnNotifier');
const manifestPath = join(projectDir, 'SubmarineReturnNotifier.json');
const internalName = 'SubmarineReturnNotifier';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} 需要一个值`);
  return value;
}
const flag = (name) => process.argv.includes(`--${name}`);

const baseUrl = arg('base-url')?.replace(/\/+$/, '');
if (!baseUrl) {
  console.error('缺少 --base-url（zip 的公网前缀，例如 https://raw.githubusercontent.com/<user>/<repo>/main/dist/repo）');
  process.exit(2);
}
if (!/^https:\/\//.test(baseUrl)) {
  console.error(`--base-url 必须是 https：${baseUrl}`);
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const version = arg('version', manifest.AssemblyVersion);

// --- 前置校验：这些字段错了 Dalumud 会静默装不上，宁可提前报错 -----------------

const problems = [];
if (!manifest.Author || manifest.Author === internalName) {
  problems.push(`Author 仍是占位值（"${manifest.Author}"），请在 ${manifestPath} 里填真实作者`);
}
if (manifest.InternalName !== internalName) {
  problems.push(`InternalName 必须是 ${internalName}，当前是 ${manifest.InternalName}`);
}
if (!version || version !== manifest.AssemblyVersion) {
  problems.push(
    `版本不一致：--version=${version} 但清单 AssemblyVersion=${manifest.AssemblyVersion}。` +
      '两者必须相同，否则 Dalamud 检测不到更新',
  );
}
if (problems.length > 0) {
  for (const p of problems) console.error('✗ ' + p);
  process.exit(1);
}

// --- 构建 ---------------------------------------------------------------------

const zipSource = join(projectDir, 'bin/Release/SubmarineReturnNotifier/latest.zip');

if (!flag('skip-build')) {
  const dotnet = arg('dotnet', process.env.DOTNET ?? 'dotnet');
  console.log(`构建 Release（dotnet=${dotnet}）…`);
  try {
    execFileSync(dotnet, ['build', join(projectDir, 'SubmarineReturnNotifier.csproj'), '-c', 'Release', '--nologo', '-v', 'q'], {
      cwd: root,
      stdio: 'inherit',
    });
  } catch {
    console.error('构建失败。插件需要 .NET 10 SDK 与 API 15 的 Dalamud 程序集：');
    console.error('  export DALAMUD_HOME=/path/to/dalamud-api15');
    process.exit(1);
  }
}

if (!existsSync(zipSource)) {
  console.error(`找不到 ${zipSource}。先构建 Release，或去掉 --skip-build。`);
  process.exit(1);
}

// --- 组装仓库 ---------------------------------------------------------------

const outDir = resolve(root, arg('out', 'dist/repo'));
mkdirSync(outDir, { recursive: true });

const zipName = `${internalName}-${version}.zip`;
const zipTarget = join(outDir, zipName);
copyFileSync(zipSource, zipTarget);

// 校验 zip 里的清单确实是这份版本（打包器拷的是构建时那一份）
const zipEntries = execFileSync('unzip', ['-l', zipTarget], { encoding: 'utf8' });
for (const required of [`${internalName}.dll`, `${internalName}.json`]) {
  if (!zipEntries.includes(required)) {
    console.error(`✗ zip 里缺少 ${required} —— Dalamud 安装时会失败`);
    process.exit(1);
  }
}

const repoUrl = arg('repo-url', manifest.RepoUrl || '');
const entry = {
  Author: manifest.Author,
  Name: manifest.Name,
  InternalName: manifest.InternalName,
  Punchline: manifest.Punchline,
  Description: manifest.Description,
  AssemblyVersion: manifest.AssemblyVersion,
  RepoUrl: repoUrl,
  ApplicableVersion: manifest.ApplicableVersion ?? 'any',
  DalamudApiLevel: manifest.DalamudApiLevel,
  DownloadLinkInstall: `${baseUrl}/${zipName}`,
  DownloadLinkUpdate: `${baseUrl}/${zipName}`,
  LoadRequiredState: manifest.LoadRequiredState ?? 0,
  LoadSync: manifest.LoadSync ?? false,
  LoadPriority: manifest.LoadPriority ?? 0,
  CanUnloadAsync: manifest.CanUnloadAsync ?? false,
  IsTestingExclusive: manifest.IsTestingExclusive ?? false,
  Tags: manifest.Tags ?? [],
  CategoryTags: manifest.CategoryTags ?? [],
  AcceptsFeedback: manifest.AcceptsFeedback ?? true,
  LastUpdate: Math.floor(Date.now() / 1000),
};
if (manifest.IconUrl) entry.IconUrl = manifest.IconUrl;
if (manifest.Version) entry.Version = manifest.Version;

const masterPath = join(outDir, 'pluginmaster.json');
// Dalamud 只接受"整个文件是一个数组"，所以永远输出数组而不是对象
writeFileSync(masterPath, JSON.stringify([entry], null, 2) + '\n');

console.log(`\n✓ ${masterPath}`);
console.log(`✓ ${zipTarget}`);
console.log(`\n清单条目：`);
console.log(`  InternalName  ${entry.InternalName}`);
console.log(`  Version       ${entry.AssemblyVersion}`);
console.log(`  API Level     ${entry.DalamudApiLevel}`);
console.log(`  Download      ${entry.DownloadLinkInstall}`);
if (!repoUrl) console.log('\n提示：RepoUrl 为空。用 --repo-url 填入插件源码地址（显示在插件详情页）。');
