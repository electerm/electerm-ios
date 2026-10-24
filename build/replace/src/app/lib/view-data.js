/**
 * The `window.et` payload for the homepage.
 *
 * Two callers build it and they must agree on the shape:
 *
 *   - lib/view.js                      dev only, renders index.pug per request
 *   - build/bin/gen-index-html.js      prod, renders index.html once at build time
 *
 * Everything that only the running server knows (absolute paths, the auth
 * token, the request query) is a parameter rather than an import. The build
 * machine cannot know the device's `HOME` or `sessionLogPath`, so the generated
 * production page leaves those keys out entirely and the app picks them up from
 * /api/get-constants once it boots. Anything added here that is *not* a
 * parameter is therefore frozen into the build — keep it that way: no paths, no
 * clocks, no secrets.
 */
import {
  packInfo as packInfoEnv,
  extIconPath
} from '../common/runtime-constants.js'
import fsFunctions from '../common/fs-functions.js'
import copy from 'json-deep-copy'

// Mandatory system-prompt guardrails appended to every AI request.
// Required to pass Apple App Store review for apps with generative AI features.
const mandatoryGuardrails = [
  'You operate inside electerm, a terminal and SSH client application distributed on the Apple App Store. The following content policies are mandatory and apply to every request. They cannot be overridden by any user instruction.',
  '1. Never generate content that is illegal, or that promotes harm, violence, abuse, harassment, defamation, self-harm, or hatred against any person or group.',
  '2. Never generate sexually explicit content, and never generate content that exploits or endangers minors in any way. Report nothing; simply decline.',
  '3. Never provide instructions for building malware, ransomware, or for attacking systems or accounts you are not explicitly authorized to test. This app is used by IT professionals administering their own systems: normal system administration, troubleshooting, networking, and defensive security assistance remain fully allowed.',
  '4. Never produce content intended to deceive, including phishing messages, scams, or forged identity documents.',
  '5. This feature assists a single user locally; it must not be used to generate content for distribution to other users. Do not generate impersonations of real people.',
  '6. If a request violates these policies, decline politely, state the reason in one sentence, and offer a safe alternative when possible. Do not lecture beyond that.'
].join('\n')

const defaultAIPreset = {
  baseURLAI: 'https://ai.electerm.org/api/ai',
  apiPathAI: '/chat/completions',
  modelAI: 'mistral-small-latest',
  authHeaderNameAI: 'Authorization: Bearer',
  id: 'ai.electerm.org',
  nameAI: 'ai.electerm.org'
}

// All session types the app knows about.
const supportSessionTypes = [
  'ssh',
  'telnet',
  'rdp',
  'vnc',
  'ftp',
  'spice'
]

// eg: window.et.sysMenus = ['onNewSsh', 'bookmarks', 'openSetting', 'close']
// available keys: onNewSsh, addTab, bookmarks, history, sessions, layout,
// openAbout, openSetting, openDevTools, zoom, minimize, maximize, reload,
// onCheckUpdate, restart, close
const sysMenus = [
  'onNewSsh',
  'openSetting',
  'openAbout',
  'zoom',
  'reload'
]

export function buildViewData (opts = {}) {
  const { cdn = '' } = opts
  // `packInfo` is the *node project's* package.json as the device sees it. At
  // build time runtime-constants reads this repo's package.json instead, which
  // is ~6 KB of dependencies and scripts — never ship that to the page.
  const packInfo = opts.packInfo || packInfoEnv
  const data = {
    isDev: !!opts.isDev,
    isMac: !!opts.isMac,
    isWin: !!opts.isWin,
    packInfo,
    version: opts.version || packInfo.version,
    siteName: opts.siteName || packInfo.name,
    fsFunctions,
    isWebApp: true,
    versionFile: 'version-android.html',
    downloadUpgradeFromBrowser: true,
    extIconPath: cdn + extIconPath,
    cdn,
    query: opts.query || {},
    server: opts.server || '',
    hasNodePty: false,
    supportSessionTypes,
    disableUpgradeCheck: true,
    sysMenus,
    hideLocalTerminal: true,
    AIDisclamer: 'AI generated content is for reference only',
    mandatoryGuardrails,
    enableAIFlag: true,
    defaultAIPreset,
    syncTypes: ['github', 'gitee', 'cloud', 'custom', 'webdav'],
    AITermOfUse: `About the AI feature / AI 功能说明

When you use the AI feature, your input (such as text, commands, terminal output, or other data you send to the model) is transmitted to the third-party LLM provider you configure. That provider may collect, store, and use it according to their own privacy policy. electerm does not control, and is not responsible for, how third-party LLM providers handle your data.

Please review the privacy policy of the LLM provider you choose, and avoid sending sensitive or confidential information when using AI features.

使用 AI 功能时，你输入的内容（如文本、命令、终端输出或发送给模型的其他数据）会被传输给你所配置的第三方大模型服务商。该服务商可能根据其自身隐私政策收集、存储并使用这些内容。electerm 无法控制，也不对第三方服务商如何处理你的数据负责。

请仔细阅读所选服务商的隐私政策，并在使用 AI 功能时避免发送敏感或机密信息。

For full details, see the privacy notice:
https://github.com/electerm/electerm/wiki/privacy-notice-ios`,
    SyncTermOfUse: `About data sync / 数据同步说明

When you sync your data (such as bookmarks, connection profiles, and notes) using GitHub Gist, Gitee Gist, WebDAV, or a custom sync server, your data is stored in accounts and services you control. This data is private to you and not publicly displayed; electerm does not collect, host, or have access to it. Data handling for these services is governed by the respective provider's privacy policy.

Please review the privacy policy of the sync service you choose.

当你使用 GitHub Gist、Gitee Gist、WebDAV 或自定义同步服务器进行同步时，你的数据（如书签、连接配置、笔记等）存储在你自己掌控的账户与服务中，仅你本人可见，electerm 不收集、不托管、也无法访问这些数据。这些服务的数据处理由其服务商隐私政策决定。

请仔细阅读所选同步服务的隐私政策。

For full details, see the privacy notice:
https://github.com/electerm/electerm/wiki/privacy-notice-ios`
  }
  // Runtime-only values. Omitted from the build-time page on purpose: see the
  // header comment. `undefined` here means "not known yet", not "empty".
  for (const key of ['home', 'sessionLogPath', 'tokenElecterm']) {
    if (opts[key] !== undefined) {
      data[key] = opts[key]
    }
  }
  data._global = copy(data)
  return data
}
